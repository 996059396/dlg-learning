const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { gradeNode, extractAnswer } = require('../lib/grading');
const { readJSON } = require('../lib/content_cache');

// Load course index
const COURSES_DIR = path.join(__dirname, '..', 'data', 'courses');

function loadCourseIndex() {
  const indexPath = path.join(COURSES_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  return readJSON(indexPath);
}

// Whitelist of real course ids → their unit ids, built from the authoritative
// course index at module load. loadUnit/loadLesson join against it so a crafted
// courseId/unitId (e.g. "..", absolute paths) can never read files outside the
// course data directories, even though Express already normalizes dot-segments.
const COURSE_IDS = new Set(loadCourseIndex().map(c => c.id));
const UNIT_IDS = new Map(loadCourseIndex().map(c => [c.id, new Set((c.units || []).map(u => u.id))]));

function loadUnit(courseId, unitId) {
  if (!COURSE_IDS.has(courseId)) return null;
  if (!UNIT_IDS.get(courseId)?.has(unitId)) return null;
  const unitPath = path.join(COURSES_DIR, courseId, `${unitId}.json`);
  if (!fs.existsSync(unitPath)) return null;
  return readJSON(unitPath);
}

function loadLesson(courseId, unitId, lessonId) {
  const unit = loadUnit(courseId, unitId);
  if (!unit || !unit.lessons) return null;
  return unit.lessons.find(l => l.id === lessonId) || null;
}

// GET /api/courses - list all courses with units
router.get('/', (req, res) => {
  const index = loadCourseIndex();
  res.json(index);
});

// GET /api/courses/progress - current user's progress.
// MUST be registered before /:courseId, or "progress" is captured by the
// wildcard and the endpoint 404s (course id "progress" doesn't exist).
router.get('/progress', requireAuth, (req, res) => {
  const progress = db.getProgress(req.userId);
  res.json(progress);
});

// GET /api/courses/:courseId - course detail with units
router.get('/:courseId', (req, res) => {
  const { courseId } = req.params;
  const index = loadCourseIndex();
  const course = index.find(c => c.id === courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(course);
});

// GET /api/courses/:courseId/units/:unitId - unit with lessons
router.get('/:courseId/units/:unitId', (req, res) => {
  const { courseId, unitId } = req.params;
  const unit = loadUnit(courseId, unitId);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  // Strip lesson content, return only metadata
  const lessonsMeta = unit.lessons.map(l => ({
    id: l.id,
    title: l.title,
    description: l.description,
    node_count: l.nodes ? l.nodes.length : 0,
    estimated_time: l.estimated_time,
  }));
  res.json({ ...unit, lessons: lessonsMeta });
});

// GET /api/courses/:courseId/units/:unitId/lessons/:lessonId - full lesson.
// Auth-gated (60-agent round 2): the payload carries answer keys (correct_answer,
// acceptable_answers, is_correct) that the lesson player needs for instant
// inline feedback — that content must not be scrapable without a session. The
// rewards path is independently server-graded, so seeing an answer never mints
// coins; this only closes the anonymous-answer-key hole.
router.get('/:courseId/units/:unitId/lessons/:lessonId', requireAuth, (req, res) => {
  const { courseId, unitId, lessonId } = req.params;
  const lesson = loadLesson(courseId, unitId, lessonId);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  res.json(lesson);
});

// POST /api/courses/:courseId/units/:unitId/lessons/:lessonId/complete
// Server-side grading: the client submits raw answers; the server re-grades each
// node against the lesson JSON and computes accuracy itself. Rewards are
// idempotent (full on first completion, review bonus on repeat) and coins are
// written to the DB in a transaction — no more client-reported accuracy, no
// more phantom coins that vanish on refresh.
router.post('/:courseId/units/:unitId/lessons/:lessonId/complete', requireAuth, (req, res) => {
  const { courseId, unitId, lessonId } = req.params;
  const lesson = loadLesson(courseId, unitId, lessonId);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers array required (server-side grading)' });
  }
  // Malformed input guard (D4): better-sqlite3 throws on non-scalar bindings
  // (object/array ids) — surface a clean 400 instead of a 500, and reject
  // entries that aren't plain objects before they reach any prepared statement.
  const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  for (const a of answers) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return res.status(400).json({ error: 'answers entries must be objects' });
    }
    if ('nodeId' in a && typeof a.nodeId !== 'string') return res.status(400).json({ error: 'nodeId must be a string' });
    if ('nodeIndex' in a && typeof a.nodeIndex !== 'number') return res.status(400).json({ error: 'nodeIndex must be a number' });
    if ('userAnswer' in a && !isScalar(a.userAnswer)) return res.status(400).json({ error: 'userAnswer must be a scalar value' });
  }
  const userId = req.userId;
  const lessonIdFull = `${courseId}/${unitId}/${lessonId}`;

  // Grade each question node (type !== 'info') server-side.
  // Addressing: PRIMARY key is the node's stable node.id (globally unique), sent
  // by the frontend. Legacy answers keyed by filtered question-index are accepted
  // as a fallback (old clients / stored payloads).
  const questionNodes = lesson.nodes.filter(n => n.type !== 'info');
  const total = questionNodes.length || 1;
  let correctCount = 0;
  const mistakes = [];
  const nodeResults = [];

  questionNodes.forEach((node, i) => {
    const entry = answers.find(a => a.nodeId === node.id) || answers.find(a => a.nodeIndex === i);
    const userAnswer = entry?.userAnswer;
    const { gradeable, correct } = gradeNode(node, userAnswer);
    // Fail closed: the server's structural verdict wins for gradeable types; a
    // node we can't re-grade is scored wrong rather than trusting the client's
    // `correct` claim (kills the "self-report 100%" minting path).
    const isCorrect = gradeable ? correct : false;
    if (isCorrect) correctCount++;
    else if (entry && node.type !== 'info') {
      mistakes.push({
        nodeId: node.id,
        nodeIndex: i,
        question: node.question || node.title || '',
        userAnswer: userAnswer ?? '',
        correctAnswer: extractAnswer(node),
      });
    }
    // P0 D telemetry: buffer per-node results so they can be written in the
    // same transaction as rewards. Correct answers were previously discarded —
    // recording them is what makes per-question p-values computable.
    nodeResults.push({ node, isCorrect, userAnswer });
  });

  const accuracy = Math.round((correctCount / total) * 100);

  // A lesson must score >= 80% to "pass": only a pass earns first-completion
  // rewards. Sub-80 attempts stay uncompleted (see below) so a retry can still
  // claim the full first-completion reward.
  const passed = accuracy >= 80;

  // Save progress + mistakes + rewards atomically.
  let rewards;
  try {
    const tx = db.db.transaction(() => {
      const existing = db.db.prepare(
        'SELECT id, completed FROM progress WHERE user_id = ? AND lesson_id = ?'
      ).get(userId, lessonIdFull);
      // C2 regression (60-agent round 2): `completed: passed` once downgraded a
      // previously-passed lesson back to 0 on a sub-80 retry, so the learner could
      // alternate pass/fail and re-claim the first-completion reward (coins) every
      // other attempt — unlimited minting. completed is now MONOTONIC: once a
      // lesson has ever been passed it stays passed, and first-completion is
      // judged by that ever-passed bit, not the current row's value.
      const wasCompleted = existing?.completed === 1;

      db.saveProgress(userId, lessonIdFull, {
        completed: wasCompleted || passed, // never downgrade a passed lesson
        score: correctCount,
        maxScore: total,
        accuracy,
      });

      // Record mistakes (only server-confirmed wrong answers).
      mistakes.forEach(m => {
        db.addMistake(userId, lessonIdFull, m.nodeId, m.nodeIndex, m.question, m.userAnswer, m.correctAnswer);
      });

      // P0 D telemetry: every graded node attempt (correct AND wrong) lands in
      // node_results inside the same transaction — the raw material for
      // per-question p-values and content calibration (P0 G).
      nodeResults.forEach(r => {
        db.addNodeResult(userId, lessonIdFull, r.node, r.isCorrect, r.userAnswer, accuracy);
      });

      // ── Rewards: idempotent, PASS-gated ──
      // A lesson must score >= 80% to "pass": only a pass earns first-completion
      // rewards (full XP / coins / heart / boost). Below the bar the attempt
      // earns a +2 effort bonus and progress stays uncompleted, so the learner
      // can retry and still claim the full first-completion reward later. This
      // kills the "submit empty answers → free 10 XP + 5 coins" farm (the server
      // previously rewarded ANY first completion regardless of accuracy).
      const isRepeat = wasCompleted;
      const xpBase = 10;
      // Effort bonus ONLY for a genuine attempt (≥1 correct answer): a blank or
      // all-wrong submission earns ZERO XP — the "+2 per empty payload" farm that
      // survived the pass-gate is now dead too.
      let xpEarned = correctCount > 0 ? 2 : 0;
      if (!isRepeat && passed) {
        xpEarned = accuracy >= 100 ? Math.round(xpBase * 1.5) : Math.round(xpBase * 1.2);
      }

      // Daily-capped: farming the same lesson over and over can no longer mint
      // unlimited +2 XP (capped at DAILY_XP_CAP per Shanghai-day).
      const actualXP = db.addLessonXP(userId, xpEarned);

      const gameState = db.getGameState(userId);
      let coinsEarned = 0;
      let heartReturned = false;
      let xpBoostTriggered = false;

      if (!isRepeat && passed) {
        coinsEarned = Math.round(xpBase / 2); // 5 coins, actually persisted now
        db.updateGameState(userId, { coins: gameState.coins + coinsEarned });

        if (gameState.hearts < gameState.max_hearts && Math.random() < 0.5) {
          db.updateGameState(userId, { hearts: gameState.hearts + 1 });
          heartReturned = true;
        }
        if (accuracy >= 100 && Math.random() < 0.3) {
          const boostEnd = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          db.updateGameState(userId, {
            xp_boost_multiplier: 2.0,
            xp_boost_until: boostEnd,
          });
          xpBoostTriggered = true;
        }
      }

      rewards = {
        xpEarned: actualXP,
        coinsEarned,
        heartReturned,
        xpBoostTriggered,
        repeat: isRepeat,
        passed,
        gradedServerSide: true,
      };
    });
    tx();
  } catch (e) {
    // Never echo e.message back — it can leak SQL table/column names (D3).
    console.error('[complete] transaction failed:', e);
    return res.status(500).json({ error: '提交失败，请重试' });
  }

  const progress = db.db.prepare(
    'SELECT * FROM progress WHERE user_id = ? AND lesson_id = ?'
  ).get(userId, lessonIdFull);

  res.json({
    progress,
    accuracy,
    rewards,
    mistakesCount: mistakes.length,
    gameState: db.getGameState(userId),
  });
});

module.exports = router;
