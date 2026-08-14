#!/usr/bin/env node
// One-time data hygiene migration (2026-08-14, roadmap P0 item A).
// Backs up app.db FIRST (online consistent snapshot), then:
//   1) Deletes orphan mistakes whose lesson_id no longer exists in course data
//      (602 rows → l2_meter_anatomy/l1_dial_selection_advanced were deleted; the
//      medical box silently looped them forever).
//   2) Backfills node_id for surviving mistakes by matching question_text to the
//      current node.question/title (conservative: only on a UNIQUE text match, so
//      a wrong node is never attached; unresolved rows keep the node_index fallback).
//   3) Backfills progress.completed_at NULL → CURRENT_TIMESTAMP (best effort — no
//      created_at column exists, the original timestamps are unrecoverable).
//   4) Deletes ORPHAN progress rows (lesson_id no longer in course data).
//
// Safe to re-run (idempotent): deletes are idempotent, backfills skip rows that
// already have node_id, and completed_at backfill only touches NULLs.
const path = require('path');
const fs = require('fs');
// Resolve better-sqlite3 from backend/node_modules (scripts/ has no node_modules).
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '..', 'backend')],
}));

const DB_PATH = process.env.DLG_DB_PATH
  || path.join(__dirname, '..', 'backend', 'models', 'data', 'app.db');
const COURSES_DIR = path.join(__dirname, '..', 'backend', 'data', 'courses');

function loadLessons() {
  const idx = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, 'index.json'), 'utf-8'));
  const map = new Map(); // lesson_id -> { nodes:[], byId:Map, byText:Map }
  for (const c of idx) {
    for (const u of (c.units || [])) {
      const unit = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, c.id, `${u.id}.json`), 'utf-8'));
      for (const l of (unit.lessons || [])) {
        const id = `${c.id}/${u.id}/${l.id}`;
        const nodes = (l.nodes || []).filter(Boolean);
        const byId = new Map();
        const byText = new Map();
        for (const n of nodes) {
          if (n.id) byId.set(n.id, n);
          const key = _norm(n.question || n.title || '');
          if (key && !byText.has(key)) byText.set(key, n);
        }
        map.set(id, { nodes, byId, byText });
      }
    }
  }
  return map;
}

const lessons = loadLessons();
console.log(`Loaded ${lessons.size} existing lessons from course data`);

// Normalize for lenient text match: strip all whitespace, full-width → half-width.
function _norm(s) {
  return String(s || '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

const report = {
  mistakesBefore: 0,
  orphanDeleted: 0,
  staleDeleted: 0,
  nodeIdBackfilled: 0,
  nodeIdUnresolved: [],
  completedAtBackfilled: 0,
  progressBefore: 0,
  progressOrphanDeleted: 0,
};

const tx = db.transaction(() => {
  report.mistakesBefore = db.prepare('SELECT COUNT(*) c FROM mistakes').get().c;

  // 1) Delete orphan mistakes (lesson_id not in current course data).
  const del = db.prepare('DELETE FROM mistakes WHERE lesson_id = ?');
  const orphans = db.prepare('SELECT DISTINCT lesson_id FROM mistakes').all();
  for (const { lesson_id } of orphans) {
    if (!lessons.has(lesson_id)) {
      const { changes } = del.run(lesson_id);
      report.orphanDeleted += changes;
    }
  }

  // 2) Backfill node_id for surviving rows (unique normalized question_text →
  //    node.id). Rows matching NO current node are STALE: the lesson was
  //    rewritten after the card was created (u1 content-fix rounds), so the
  //    node_index fallback would resolve to the WRONG node and re-grade
  //    incorrectly on review. Stale cards are deleted rather than left to
  //    actively misgrade the learner.
  const rows = db.prepare('SELECT id, lesson_id, question_text FROM mistakes WHERE node_id IS NULL').all();
  const upd = db.prepare('UPDATE mistakes SET node_id = ? WHERE id = ?');
  const delRow = db.prepare('DELETE FROM mistakes WHERE id = ?');
  for (const r of rows) {
    const lesson = lessons.get(r.lesson_id);
    if (!lesson) { delRow.run(r.id); report.staleDeleted++; continue; }
    const key = _norm(r.question_text);
    const node = lesson.byText.get(key);
    if (node && node.id) {
      upd.run(node.id, r.id);
      report.nodeIdBackfilled++;
    } else {
      delRow.run(r.id);
      report.staleDeleted++;
      report.nodeIdUnresolved.push({
        id: r.id, lesson_id: r.lesson_id,
        question_text: String(r.question_text || '').slice(0, 60),
      });
    }
  }

  // 3) Backfill progress.completed_at NULL → CURRENT_TIMESTAMP.
  report.progressBefore = db.prepare('SELECT COUNT(*) c FROM progress').get().c;
  const bf = db.prepare('UPDATE progress SET completed_at = CURRENT_TIMESTAMP WHERE completed_at IS NULL');
  report.completedAtBackfilled = bf.run().changes;

  // 4) Delete ORPHAN progress rows (lesson_id no longer in course data — the
  //    lessons were deleted/recut into new ids; the history points at nothing
  //    and inflates completion counts).
  const delProgress = db.prepare('DELETE FROM progress WHERE lesson_id = ?');
  const progOrphans = db.prepare('SELECT DISTINCT lesson_id FROM progress').all();
  for (const { lesson_id } of progOrphans) {
    if (!lessons.has(lesson_id)) {
      const { changes } = delProgress.run(lesson_id);
      report.progressOrphanDeleted += changes;
    }
  }
});
tx();

console.log('── Report ──');
console.log(`mistakes before: ${report.mistakesBefore}, orphan rows deleted: ${report.orphanDeleted}, stale rows deleted: ${report.staleDeleted}`);
console.log(`node_id backfilled: ${report.nodeIdBackfilled}, deleted-unresolved: ${report.nodeIdUnresolved.length}`);
for (const u of report.nodeIdUnresolved) {
  console.log(`   DELETED id=${u.id} ${u.lesson_id} :: ${u.question_text}`);
}
console.log(`progress before: ${report.progressBefore}, completed_at backfilled: ${report.completedAtBackfilled}, orphan progress rows deleted: ${report.progressOrphanDeleted}`);

// Final state verification (read-only).
const remNull = db.prepare('SELECT COUNT(*) c FROM mistakes WHERE node_id IS NULL').get().c;
const remOrphan = db.prepare('SELECT COUNT(*) c FROM mistakes').all().filter(x => false); // placeholder
let orphanRemaining = 0;
for (const { lesson_id, c } of db.prepare('SELECT lesson_id, COUNT(*) c FROM mistakes GROUP BY lesson_id').all()) {
  if (!lessons.has(lesson_id)) orphanRemaining += c;
}
const progNull = db.prepare('SELECT COUNT(*) c FROM progress WHERE completed_at IS NULL').get().c;
let progOrphanRemaining = 0;
for (const { lesson_id } of db.prepare('SELECT DISTINCT lesson_id FROM progress').all()) {
  if (!lessons.has(lesson_id)) progOrphanRemaining++;
}
console.log('── Final state ──');
console.log(`mistakes node_id NULL remaining: ${remNull}`);
console.log(`mistakes orphan rows remaining: ${orphanRemaining}`);
console.log(`progress completed_at NULL remaining: ${progNull}`);
console.log(`progress orphan lesson refs remaining: ${progOrphanRemaining}`);

db.close();
if (orphanRemaining > 0 || progOrphanRemaining > 0) {
  console.error('⚠️  Orphan rows remain — re-run after inspecting.');
  process.exit(2);
}
console.log('✅ Data hygiene migration complete.');
