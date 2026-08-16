const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate_limit');
const { gradeNode, extractAnswer } = require('../lib/grading');
const { readJSON, changeKey } = require('../lib/content_cache');

// Load course index
const COURSES_DIR = path.join(__dirname, '..', 'data', 'courses');
const INDEX_PATH = path.join(COURSES_DIR, 'index.json');

function loadCourseIndex() {
  if (!fs.existsSync(INDEX_PATH)) return [];
  return readJSON(INDEX_PATH);
}

// Whitelist of real course ids → their unit ids, from the authoritative course
// index. loadUnit/loadLesson join against it so a crafted courseId/unitId
// (e.g. "..", absolute paths) can never read files outside the course data
// directories, even though Express already normalizes dot-segments.
// Refreshed lazily when index.json changes (changeKey), so an editor adding a
// new course/unit at runtime is picked up without a restart — previously the
// Sets were frozen at module load and hot-added units 404'd forever.
let _idxKey = null;
let COURSE_IDS = new Set();
let UNIT_IDS = new Map();

function refreshWhitelistIfChanged() {
  if (!fs.existsSync(INDEX_PATH)) return;
  const key = changeKey(INDEX_PATH);
  if (key === _idxKey) return;
  _idxKey = key;
  const index = loadCourseIndex();
  COURSE_IDS = new Set(index.map(c => c.id));
  UNIT_IDS = new Map(index.map(c => [c.id, new Set((c.units || []).map(u => u.id))]));
}

function loadUnit(courseId, unitId) {
  refreshWhitelistIfChanged();
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
// coins; this only closes the anonymous-answer-key hole. Rate-limited to slow
// full-repo answer dumps (a learner loads ≤ a few dozen lessons/session; a
// scraper pulls 704 in seconds) — rate-limit ≠ real anti-cheat, the accepted
// residual is documented in CLAUDE.md.
router.get('/:courseId/units/:unitId/lessons/:lessonId',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 240, scope: 'lesson-views', key: (req) => req.ip }),
  requireAuth, (req, res) => {
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
// Rate-limited (crosscheck5 C medium): /complete returns correctAnswer for each
// wrong node (:196), so it is an answer-key channel too. The heart economy (5
// per fresh account) and register bucket already bound mass scraping; this
// closes the per-IP burst. Generous: 200/15min ≈ 13/min, far above a learner.
router.post('/:courseId/units/:unitId/lessons/:lessonId/complete',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 200, scope: 'complete-submit', key: (req) => req.ip }),
  requireAuth, (req, res) => {
  const { courseId, unitId, lessonId } = req.params;
  const lesson = loadLesson(courseId, unitId, lessonId);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });

  const { answers, client_request_id } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ error: 'answers array required (server-side grading)' });
  }
  // X02 offline-sync idempotency key. Optional; a replay of the same
  // (user, client_request_id) returns the ORIGINAL response without re-grading.
  // Bounded: 8–64 chars, no slashes (a slash would make the request path
  // ambiguous and the string never appears in any URL).
  const reqId = (typeof client_request_id === 'string' && client_request_id.length >= 8 && client_request_id.length <= 64 && !client_request_id.includes('/'))
    ? client_request_id
    : null;
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

  // X02 replay short-circuit: the offline queue re-sends the same key after a
  // lost response. The receipt row holds the response JSON that was already
  // persisted (rewards, progress, gameState snapshots) — return it verbatim so
  // the retry neither re-grades nor re-mints. A receipt can't be forged: it is
  // keyed by (user_id, client_request_id) and only written inside the grading
  // transaction below.
  if (reqId) {
    const receipt = db.db.prepare(
      'SELECT response_json FROM submission_receipts WHERE user_id = ? AND client_request_id = ?'
    ).get(userId, reqId);
    if (receipt) {
      try {
        return res.json(JSON.parse(receipt.response_json));
      } catch (e) {
        // Corrupt receipt (shouldn't happen) — fall through and re-grade fresh.
        console.error('[complete] corrupt receipt for', reqId, e);
      }
    }
  }

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

  const wrongCount = mistakes.length;
  const accuracy = Math.round((correctCount / total) * 100);

  // A lesson must score >= 80% to "pass": only a pass earns first-completion
  // rewards. Sub-80 attempts stay uncompleted (see below) so a retry can still
  // claim the full first-completion reward.
  const passed = accuracy >= 80;

  // Complete 红心门禁（P1 残留项）：红心惩罚移入服务端。本次有错题时每错扣一心
  // （见事务内扣心）；红心已耗尽且本次有错 → 拒绝提交，与 /game/use-heart 的
  // 「红心≤0 拒绝」一致。全对提交不消耗红心，红心 0 时仍可全对通过，不卡学习。
  if (wrongCount > 0) {
    const gate = db.getGameState(userId);
    if (gate.hearts <= 0) {
      return res.status(400).json({ error: '红心不足，无法提交错题练习', needsHearts: true });
    }
  }

  // Save progress + mistakes + rewards atomically.
  let rewards;
  let responseBody;
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
      // 服务端扣心：每答错一题扣一心，扣到 0 为止（红心经济惩罚不再依赖前端展示）。
      if (wrongCount > 0) {
        const heartsAfter = Math.max(0, gameState.hearts - wrongCount);
        db.updateGameState(userId, { hearts: heartsAfter });
      }
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
        heartCost: wrongCount > 0 ? Math.min(gameState.hearts, wrongCount) : 0,
        heartReturned,
        xpBoostTriggered,
        repeat: isRepeat,
        passed,
        gradedServerSide: true,
      };

      // Assemble the response INSIDE the transaction so the receipt stores the
      // exact snapshot that the rewards were minted against — a replay of the
      // same client_request_id must return byte-identical rewards, never a
      // re-grade with drifting gameState.
      const responseBody = {
        progress: db.db.prepare(
          'SELECT * FROM progress WHERE user_id = ? AND lesson_id = ?'
        ).get(userId, lessonIdFull),
        accuracy,
        rewards,
        mistakesCount: mistakes.length,
        gameState: db.getGameState(userId),
      };

      // X02: persist the idempotency receipt in the same transaction as the
      // rewards. Retention: purge this user's receipts older than 30 days so
      // the table doesn't grow unbounded (offline queues flush within minutes).
      if (reqId) {
        db.db.prepare(
          "DELETE FROM submission_receipts WHERE user_id = ? AND created_at < datetime('now', '-30 days')"
        ).run(userId);
        db.db.prepare(
          'INSERT INTO submission_receipts (user_id, client_request_id, response_json) VALUES (?, ?, ?)'
        ).run(userId, reqId, JSON.stringify(responseBody));
      }
      return responseBody;
    });
    responseBody = tx();
  } catch (e) {
    // Never echo e.message back — it can leak SQL table/column names (D3).
    console.error('[complete] transaction failed:', e);
    return res.status(500).json({ error: '提交失败，请重试' });
  }

  res.json(responseBody);
});

module.exports = router;
