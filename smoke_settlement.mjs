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

// ── P26 P2: small leagues must not promote everyone / never demote ──
// A full 5-player silver league with static zones (promoteTop 5 + demoteBottom 5
// = 10 > 5) used to promote ALL 5 and demote 0, inflating tiers every week. The
// effective-zone scaling must promote only the top ~2, demote the bottom ~2, and
// keep a middle rank in place.
await test('small league (5 players) scales zones: not everyone promotes', () => {
  const week = db.getWeekStart(Date.now() - 21 * 86400 * 1000); // 3 weeks ago, untouched
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = `user-silver${i}`;
    db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(id, `银${i}`);
    db.db.prepare('INSERT INTO game_state (user_id, league) VALUES (?, ?)').run(id, 'silver');
    db.db.prepare('INSERT INTO leaderboard (user_id, week_start, xp_earned, league) VALUES (?, ?, ?, ?)')
      .run(id, week, 500 - i * 80, 'silver'); // 500, 420, 340, 260, 180
    ids.push(id);
  }
  const res = db.settleWeek(week);
  const changes = res.settled.filter(s => s.change === 'promoted' || s.change === 'demoted');
  const promoted = changes.filter(s => s.change === 'promoted').length;
  const demoted = changes.filter(s => s.change === 'demoted').length;
  if (promoted < 1 || promoted >= 5) throw new Error(`expected partial promotion, got ${promoted}/5`);
  if (demoted < 1 || demoted >= 5) throw new Error(`expected partial demotion, got ${demoted}/5`);
  if (promoted + demoted >= 5) throw new Error(`promote+demote must leave a stay rank, got ${promoted}+${demoted}`);
  // Winner promoted, loser demoted, nobody double-changed.
  const winner = res.settled.find(s => s.rank === 1);
  const loser = res.settled.find(s => s.rank === 5);
  if (winner.change !== 'promoted') throw new Error(`rank1 should promote, got ${winner.change}`);
  if (loser.change !== 'demoted') throw new Error(`rank5 should demote, got ${loser.change}`);
  if (res.settled.some(s => s.nextLeague === s.league && s.change !== 'stay')) {
    throw new Error('tier change applied but nextLeague unchanged');
  }
});

// ── P26 P2: 0-XP protection still respected in a small league ──
await test('small league: zero-XP bottom stays (MIN_XP_TO_DEMOTE)', () => {
  const week = db.getWeekStart(Date.now() - 28 * 86400 * 1000); // 4 weeks ago
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const id = `user-xp${i}`;
    db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(id, `保${i}`);
    db.db.prepare('INSERT INTO game_state (user_id, league) VALUES (?, ?)').run(id, 'emerald');
    db.db.prepare('INSERT INTO leaderboard (user_id, week_start, xp_earned, league) VALUES (?, ?, ?, ?)')
      .run(id, week, [300, 200, 100, 0][i], 'emerald');
    ids.push(id);
  }
  const res = db.settleWeek(week);
  const last = res.settled.find(s => s.xp === 0);
  if (last && last.change === 'demoted') throw new Error('0-XP player must not be demoted');
});

// ── B58 #75 SM-2 upgrade: EF-on-failure fix, review_log, tiered queue ──

await test('SM-2: failed recall does NOT lower EF (SM-2 canonical step 6)', () => {
  const uid = 'user-ef';
  db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(uid, 'EF测试');
  db.db.prepare('INSERT INTO game_state (user_id, league) VALUES (?, ?)').run(uid, 'bronze');
  db.addMistake(uid, 'course/u/l', 'n-ef', 0, '问题', 'wrong', 'right');
  const row = db.db.prepare("SELECT id FROM mistakes WHERE node_id='n-ef'").get();
  // Wrong → q=2. The old code applied the EF formula on failures (ΔEF=-0.32),
  // ratcheting hard cards toward the 1.3 floor. SM-2 says failures don't change EF.
  db.reviewMistake(row.id, uid, false, false);
  let r = db.db.prepare('SELECT * FROM mistakes WHERE id=?').get(row.id);
  if (r.easiness !== 2.5) throw new Error(`failure lowered EF: ${r.easiness}`);
  if (r.interval_days !== 1) throw new Error(`failure must reset interval to 1, got ${r.interval_days}`);
  // Correct recalls climb the ladder 1 → 6 → grows, EF never below pre-failure.
  db.reviewMistake(row.id, uid, true, false);
  r = db.db.prepare('SELECT * FROM mistakes WHERE id=?').get(row.id);
  if (r.interval_days !== 1) throw new Error(`1st correct after failure → interval 1, got ${r.interval_days}`);
  db.reviewMistake(row.id, uid, true, false);
  r = db.db.prepare('SELECT * FROM mistakes WHERE id=?').get(row.id);
  if (r.interval_days !== 6) throw new Error(`2nd correct → interval 6, got ${r.interval_days}`);
  if (r.easiness < 2.5) throw new Error(`EF dropped below pre-failure value: ${r.easiness}`);
});

await test('reviewMistake appends review_log history (retention data base)', () => {
  const uid = 'user-log';
  db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(uid, 'LOG测试');
  db.db.prepare('INSERT INTO game_state (user_id, league) VALUES (?, ?)').run(uid, 'bronze');
  db.addMistake(uid, 'course/u/l', 'n-log', 0, '问题', 'wrong', 'right');
  const row = db.db.prepare("SELECT id, easiness, interval_days FROM mistakes WHERE node_id='n-log'").get();
  const before = row.interval_days;
  db.reviewMistake(row.id, uid, true, false, { responseTimeMs: 2500, sessionId: 'test-sess' });
  const logs = db.db.prepare('SELECT * FROM review_log WHERE mistake_id=?').all(row.id);
  if (logs.length !== 1) throw new Error(`expected 1 log row, got ${logs.length}`);
  const l = logs[0];
  if (l.correct !== 1 || l.quality !== 4) throw new Error('log must record correct/quality');
  if (l.interval_before !== before) throw new Error('interval_before mismatch');
  if (l.ease_before !== 2.5) throw new Error('ease_before mismatch');
  if (l.response_time_ms !== 2500 || l.session_id !== 'test-sess') throw new Error('telemetry not logged');
  if (!l.reviewed_at) throw new Error('reviewed_at missing');
});

await test('mistake queue is tiered: due reviews first, offset pages everything', () => {
  const uid = 'user-tier';
  db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(uid, 'TIER测试');
  db.db.prepare('INSERT INTO game_state (user_id, league) VALUES (?, ?)').run(uid, 'bronze');
  const today = db.todayShanghai();
  // 5 NEW learning-step cards (review_count=0, due today).
  for (let i = 0; i < 5; i++) db.addMistake(uid, 'course/u/l', `n-new-${i}`, 0, `新${i}`, 'x', 'y');
  // 3 DUE REVIEW cards (review_count=1, backdated to be overdue).
  for (let i = 0; i < 3; i++) {
    db.addMistake(uid, 'course/u/l', `n-old-${i}`, 0, `旧${i}`, 'x', 'y');
    const r = db.db.prepare('SELECT id FROM mistakes WHERE node_id=?').get(`n-old-${i}`);
    db.reviewMistake(r.id, uid, true, false);
    db.db.prepare('UPDATE mistakes SET next_review_date=? WHERE id=?').run(today, r.id);
  }
  // limit=6: overdue reviews first (到期最久优先), then new cards.
  const page1 = db.getUnreviewedMistakes(uid, 6, 0);
  if (page1.length !== 6) throw new Error(`expected 6 on page1, got ${page1.length}`);
  if (page1.slice(0, 3).some(m => m.review_count === 0)) throw new Error('overdue reviews must precede new cards');
  // offset=6: the remaining 2 new cards are still reachable (pagination works).
  const page2 = db.getUnreviewedMistakes(uid, 6, 6);
  if (page2.length !== 2) throw new Error(`expected 2 on page2, got ${page2.length}`);
  if (page2.some(m => m.review_count !== 0)) throw new Error('page2 should be the remaining new cards');
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
