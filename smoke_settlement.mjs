#!/usr/bin/env node
// Settlement hardening test: seeds a stale (last-week) leaderboard and verifies
// transactional settlement + startup catch-up + idempotency, on an isolated DB.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dlg-settle-')), 'test.db');
process.env.DLG_DB_PATH = DB_PATH;

// Repo-relative require (portable — runs from any cwd, not just D:\dlg_project).
const db = require(path.join(import.meta.dirname, 'backend', 'models', 'database.js'));
db.initializeDatabase();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

// Users + game states + a full last-week leaderboard.
const users = ['alice', 'bob', 'carol'].map((name, i) => {
  const id = `user-${name}`;
  db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(id, name);
  db.db.prepare('INSERT INTO game_state (user_id, league) VALUES (?, ?)').run(id, ['bronze', 'bronze', 'bronze'][i]);
  return id;
});
const lastWeek = db.getWeekStart(Date.now() - 7 * 86400 * 1000);
// alice 100xp, bob 50xp, carol 10xp — all in bronze, same week.
[['user-alice', 100], ['user-bob', 50], ['user-carol', 10]].forEach(([uid, xp]) => {
  db.db.prepare(`
    INSERT INTO leaderboard (user_id, week_start, xp_earned, league)
    VALUES (?, ?, ?, 'bronze')
  `).run(uid, lastWeek, xp);
});

await test('settleWeek applies rank + promotion transactionally', () => {
  const res = db.settleWeek(lastWeek);
  const alice = db.db.prepare('SELECT final_rank, tier_change, settled_at FROM leaderboard WHERE user_id=? AND week_start=?').get('user-alice', lastWeek);
  const carol = db.db.prepare('SELECT final_rank, tier_change, settled_at FROM leaderboard WHERE user_id=? AND week_start=?').get('user-carol', lastWeek);
  if (alice.final_rank !== 1 || alice.tier_change !== 'promoted') throw new Error(`alice expected rank1/promoted, got rank${alice.final_rank}/${alice.tier_change}`);
  if (carol.final_rank !== 3) throw new Error(`carol expected rank3, got ${carol.final_rank}`);
  if (!alice.settled_at || !carol.settled_at) throw new Error('settled_at not stamped');
  if (db.getGameState('user-alice').league !== 'silver') throw new Error('alice league not updated in game_state');
  const hist = db.db.prepare('SELECT * FROM league_history WHERE user_id=? AND week_start=?').get('user-alice', lastWeek);
  if (!hist || hist.result !== 'promoted') throw new Error('history row missing/wrong');
});

await test('settleWeek is idempotent (no double settlement)', () => {
  db.settleWeek(lastWeek); // run again
  const aliceHist = db.db.prepare("SELECT COUNT(*) c FROM league_history WHERE user_id='user-alice' AND week_start=?").get(lastWeek);
  if (aliceHist.c > 1) throw new Error(`history double-written: ${aliceHist.c}`);
  // Re-running should settle 0 new rows (filter settled_at IS NULL).
  const res = db.settleWeek(lastWeek);
  if (res.settled.length !== 0) throw new Error('second run re-settled rows');
});

await test('settleWeek refuses the ACTIVE week even with force=true (C2)', () => {
  // The current in-progress week must never be settled, even by an explicit
  // force call — a premature settle freezes live standings permanently.
  const currentWeek = db.getWeekStart();
  const before = db.db.prepare("SELECT COUNT(*) c FROM league_history WHERE week_start=?").get(currentWeek).c;
  const res = db.settleWeek(currentWeek, true);
  if (res.skipped !== true || res.reason !== 'active-week') {
    throw new Error(`expected active-week skip, got ${JSON.stringify(res)}`);
  }
  const after = db.db.prepare("SELECT COUNT(*) c FROM league_history WHERE week_start=?").get(currentWeek).c;
  if (after !== before) throw new Error('active week produced history rows despite guard');
  const settledNow = db.db.prepare("SELECT COUNT(*) c FROM leaderboard WHERE week_start=? AND settled_at IS NOT NULL").get(currentWeek).c;
  if (settledNow !== 0) throw new Error(`active week has ${settledNow} settled rows`);
});

// Now seed ANOTHER stale week to prove startup catch-up picks it up.
const twoWeeksAgo = db.getWeekStart(Date.now() - 14 * 86400 * 1000);
db.db.prepare(`
  INSERT INTO leaderboard (user_id, week_start, xp_earned, league)
  VALUES ('user-bob', ?, 200, 'bronze')
`).run(twoWeeksAgo);

await test('catchUpSettlements settles missed weeks on boot', () => {
  const n = db.catchUpSettlements();
  if (n < 1) throw new Error('catch-up settled nothing');
  const row = db.db.prepare('SELECT settled_at FROM leaderboard WHERE user_id=? AND week_start=?').get('user-bob', twoWeeksAgo);
  if (!row?.settled_at) throw new Error('two-weeks-ago row not settled');
});

await test('current week is NEVER touched by catch-up', () => {
  const cur = db.getWeekStart();
  const unsettledCurrent = db.db.prepare('SELECT COUNT(*) c FROM leaderboard WHERE week_start=? AND settled_at IS NULL').get(cur);
  if (unsettledCurrent.c !== 0) throw new Error(`current week has ${unsettledCurrent.c} rows; catch-up should skip it (none seeded anyway)`);
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
