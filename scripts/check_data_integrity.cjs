#!/usr/bin/env node
// Data-integrity canary (roadmap P0 item A): verifies the LIVE database holds
// no orphaned references into the course content. Content edits that DELETE or
// REWRITE lessons (recuts, restructures) silently orphan mistakes/progress rows
// — the medical box then loops forever on cards that can never be mastered, and
// progress points at lessons that no longer exist. Run after any content change
// (`npm run test:data` from backend/); exits 1 when orphans exist so the edit
// that caused them must also clean the DB (see scripts/cleanup_data_hygiene.cjs).
//
// Read-only: never modifies app.db.
const path = require('path');
const fs = require('fs');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', 'backend')],
}));

const DB_PATH = process.env.DLG_DB_PATH
  || path.join(__dirname, '..', 'backend', 'models', 'data', 'app.db');
const COURSES_DIR = path.join(__dirname, '..', 'backend', 'data', 'courses');

function loadLessons() {
  const idx = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, 'index.json'), 'utf-8'));
  const map = new Map();
  for (const c of idx) {
    for (const u of (c.units || [])) {
      const unit = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, c.id, `${u.id}.json`), 'utf-8'));
      for (const l of (unit.lessons || [])) {
        const id = `${c.id}/${u.id}/${l.id}`;
        const nodeIds = new Set((l.nodes || []).filter(n => n && n.id).map(n => n.id));
        map.set(id, nodeIds);
      }
    }
  }
  // The multi-select exam pool is a legitimate mistake source (lesson_id
  // 'exam/ms_pool') even though 'exam' is not a real course — pool mistakes
  // are resolved by game.js loadMistakeNode. Validate their node_ids against it.
  const poolPath = path.join(__dirname, '..', 'backend', 'data', 'exam', 'multi_select.json');
  if (fs.existsSync(poolPath)) {
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
    map.set('exam/ms_pool', new Set(pool.filter(n => n && n.id).map(n => n.id)));
  }
  return map;
}

if (!fs.existsSync(DB_PATH)) {
  console.log('No app.db found (fresh clone) — data-integrity canary skipped.');
  process.exit(0);
}

const lessons = loadLessons();
const db = new Database(DB_PATH, { readonly: true });

const problems = [];

// 1) mistakes: lesson_id must exist; node_id must exist inside that lesson.
for (const row of db.prepare('SELECT id, lesson_id, node_id, question_text FROM mistakes').all()) {
  const nodeIds = lessons.get(row.lesson_id);
  if (!nodeIds) {
    problems.push(`mistakes id=${row.id} references missing lesson ${row.lesson_id}`);
    continue;
  }
  if (row.node_id && !nodeIds.has(row.node_id)) {
    problems.push(`mistakes id=${row.id} node_id ${row.node_id} not in lesson ${row.lesson_id}`);
  }
  if (!row.node_id) {
    problems.push(`mistakes id=${row.id} has NULL node_id (no stable addressing — re-grade may hit the wrong node)`);
  }
}

// 2) progress: lesson_id must exist.
for (const row of db.prepare('SELECT id, user_id, lesson_id FROM progress').all()) {
  if (!lessons.has(row.lesson_id)) {
    problems.push(`progress id=${row.id} references missing lesson ${row.lesson_id}`);
  }
}

// 2b) mistakes: duplicate (user_id, lesson_id, node_id) cards. addMistake guards
//     on that triple, so duplicates mean a write path bypassed it — the medical
//     box then shows the same card twice and review_credit mint is doubled.
for (const row of db.prepare(`
  SELECT user_id, lesson_id, node_id, COUNT(*) c, GROUP_CONCAT(id) ids
  FROM mistakes WHERE node_id IS NOT NULL
  GROUP BY user_id, lesson_id, node_id HAVING c > 1
`).all()) {
  problems.push(`mistakes 重复卡: (${row.user_id}, ${row.lesson_id}, ${row.node_id}) ×${row.c} [ids=${row.ids}]`);
}

// 3) users 计数哨兵: 账号表不能被意外清空。
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount < 1) problems.push('users 表为空 (0 行) — 账号数据丢失或表损坏');
else console.log(`  users: ${userCount} 行`);

// 4) 外键完整性哨兵: 任何违规(孤儿引用)即失败。数据库写入时开了
//    foreign_keys=ON, 正常不可能出现; 出现即说明有绕过约束的写入路径。
for (const v of db.prepare('PRAGMA foreign_key_check').all()) {
  problems.push(`外键违规: ${v.table}.rowid=${v.rowid} → 引用 ${v.parent} (fkid=${v.fkid})`);
}

db.close();

if (problems.length === 0) {
  console.log(`✅ Data integrity OK (${lessons.size} lessons, no orphans, no NULL node_id).`);
  process.exit(0);
}
console.error(`❌ Data integrity FAIL — ${problems.length} problem(s):`);
for (const p of problems) console.error('   ' + p);
process.exit(1);
