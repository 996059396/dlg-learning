#!/usr/bin/env node
// Live-DB test-data cleanup (2026-08-16, task #99).
// Idempotent, backups FIRST (online consistent snapshot), then:
//   1) Deletes DUPLICATE mistake cards — same (user_id, lesson_id, node_id)
//      twice. addMistake guards on that triple, so duplicates mean a write path
//      bypassed it (live DB held 5 pairs after browser-e2e probe runs); the
//      medical box then shows one card twice and review_credit mint is doubled.
//      Rule: keep MIN(id), delete the rest.
//   2) Deletes TEST users (browser e2e registrations `e2e_*` / `mm_e2e_*`,
//      crosscheck probe accounts `v10*` / `v22*` / `x05_*`) and every dependent
//      row. Demo user 小电工 is always kept.
//
// Safe to re-run: dedup keeps MIN(id) so nothing left to delete; test users
// simply don't exist any more.
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', 'backend')],
}));

const DB_PATH = process.env.DLG_DB_PATH
  || path.join(__dirname, '..', 'backend', 'models', 'data', 'app.db');
const BACKUP = process.env.DLG_BACKUP_DIR
  || path.join(__dirname, '..', 'backend', 'models', 'data', 'backups');

function isTestUser(username) {
  return /^(e2e_|mm_e2e_|v10|v22|x05)/.test(username || '');
}

// 0) Backup first — destructive-op red line.
const note = process.argv[2] || 'before_test_data_cleanup';
const bk = spawnSync(process.execPath, [path.join(__dirname, 'backup_db.cjs'), note], {
  stdio: 'inherit',
});
if (bk.status !== 0) {
  console.error('❌ 备份失败，中止清理。');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

const report = { dedupDeleted: 0, testUsers: 0, mistakesDeleted: 0, rowsDeleted: {} };

const tx = db.transaction(() => {
  // 1) Dedupe mistake cards: keep MIN(id) per (user, lesson, node).
  const dupGroups = db.prepare(`
    SELECT MIN(id) keep_id, GROUP_CONCAT(id) ids, COUNT(*) c
    FROM mistakes GROUP BY user_id, lesson_id, node_id HAVING c > 1
  `).all();
  for (const g of dupGroups) {
    const toDelete = String(g.ids).split(',').map(Number).filter(id => id !== g.keep_id);
    for (const id of toDelete) {
      db.prepare('DELETE FROM review_log WHERE mistake_id = ?').run(id);
      db.prepare('DELETE FROM review_credit WHERE mistake_id = ?').run(id);
      db.prepare('DELETE FROM mistakes WHERE id = ?').run(id);
      report.dedupDeleted++;
    }
  }

  // 2) Delete test users + dependents.
  const targets = db.prepare('SELECT id, username FROM users').all()
    .filter(u => isTestUser(u.username));
  for (const u of targets) {
    const before = db.prepare('SELECT COUNT(*) c FROM mistakes WHERE user_id = ?').get(u.id).c;
    const logs = db.prepare('DELETE FROM review_log WHERE mistake_id IN (SELECT id FROM mistakes WHERE user_id = ?)').run(u.id).changes;
    const credits = db.prepare('DELETE FROM review_credit WHERE mistake_id IN (SELECT id FROM mistakes WHERE user_id = ?)').run(u.id).changes;
    const mistakes = db.prepare('DELETE FROM mistakes WHERE user_id = ?').run(u.id).changes;
    const tabs = ['sessions', 'game_state', 'progress', 'inventory', 'leaderboard',
      'league_history', 'node_results', 'submission_receipts', 'exam_sessions'];
    const per = {};
    for (const t of tabs) {
      per[t] = db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u.id).changes;
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    report.testUsers++;
    report.mistakesDeleted += mistakes;
    report.rowsDeleted[u.username] = { mistakes, logs, credits, ...per };
    void before;
  }
});
tx();

console.log('── Report ──');
console.log(`duplicate mistake pairs removed: ${report.dedupDeleted}`);
console.log(`test users deleted: ${report.testUsers} (mistakes ${report.mistakesDeleted})`);
for (const [name, r] of Object.entries(report.rowsDeleted)) {
  console.log(`   ${name}: mistakes=${r.mistakes} logs=${r.logs} credits=${r.credits} sessions=${r.sessions} game_state=${r.game_state} progress=${r.progress} inventory=${r.inventory} leaderboard=${r.leaderboard} league=${r.league_history} node_results=${r.node_results} receipts=${r.submission_receipts} exam=${r.exam_sessions}`);
}

// 3) Final-state verification (read-only).
const dupLeft = db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT 1 FROM mistakes GROUP BY user_id, lesson_id, node_id HAVING COUNT(*) > 1
  )
`).get().c;
const users = db.prepare('SELECT username FROM users ORDER BY username').all().map(u => u.username);
const testLeft = users.filter(isTestUser);
console.log('── Final state ──');
console.log(`remaining users (${users.length}): ${users.join(', ')}`);
console.log(`duplicate mistake groups remaining: ${dupLeft}`);
console.log(`test users remaining: ${testLeft.length}`);

db.close();

if (dupLeft > 0 || testLeft.length > 0) {
  console.error('⚠️ 仍有残留，请人工检查。');
  process.exit(2);
}
console.log('✅ Live test-data cleanup complete.');
