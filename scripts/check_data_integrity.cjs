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

db.close();

if (problems.length === 0) {
  console.log(`✅ Data integrity OK (${lessons.size} lessons, no orphans, no NULL node_id).`);
  process.exit(0);
}
console.error(`❌ Data integrity FAIL — ${problems.length} problem(s):`);
for (const p of problems) console.error('   ' + p);
process.exit(1);
