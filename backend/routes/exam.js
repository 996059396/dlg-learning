// Mock exam engine (P1 value anchor): full 考证 simulation — 100 questions
// (60 判断 + 30 单选 + 10 多选) / 45 min / 80 pass, reusing gradeNode for
// server-side grading. Wrong answers auto-enter SM-2 mistakes.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate_limit');
const { gradeNode, extractAnswer } = require('../lib/grading');
const { readJSON } = require('../lib/content_cache');

const COURSES_DIR = path.join(__dirname, '..', 'data', 'courses');
const MS_POOL = path.join(__dirname, '..', 'data', 'exam', 'multi_select.json');
const EXAM_PASS_SCORE = 80;
// 防切屏阈值（compare60 C04/C14，全真模式）：切屏 ≥3 次或累计离开 ≥30s 标记异常。
// 异常不取消成绩（错题照常入册复习），但扣发当日首次通过的 30 金币——切出去查答案→
// 90+ 拿币的刷币链被经济性封堵。阈值刻意宽松：正常答题间偶尔切出看时间不会被误伤。
const ANOMALY_SWITCHES = 3;
const ANOMALY_HIDDEN_MS = 30 * 1000;
// 双模式（crosscheck5 S M4 决策落地）：
//  - real 全真：100 题 / 120 分钟 / 仅判断+单选 / 80 分 —— 对齐真实低压电工理论机考
//    （应急〔2025〕59 号《培训大纲和考核标准》、应急管理部令第 19 号，2026-06-01 施行；
//    官方附件未逐字公布题量配比，实际机考随全国题库随机抽题，60/40 为近似口径）；
//  - training 训练：100 题 / 45 分钟 / 含 10 道多选 —— 原格式，多选作训练用途。
const EXAM_MODES = {
  real: { minutes: 120, counts: { true_false: 60, multiple_choice: 40, multi_select: 0 }, label: '全真' },
  training: { minutes: 45, counts: { true_false: 60, multiple_choice: 30, multi_select: 10 }, label: '训练' },
};
function resolveMode(req) {
  const m = String((req.body && req.body.mode) || (req.query && req.query.mode) || 'real');
  return EXAM_MODES[m] ? m : 'real';
}

// Idempotent schema bootstrap (route module load time). 防切屏字段（compare60 C04/C14）
// 已并入 CREATE；存量库用 PRAGMA table_info 检测后 ALTER 补齐——重启不重复加列。
db.db.exec(`
  CREATE TABLE IF NOT EXISTS exam_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    score INTEGER,
    total INTEGER,
    passed INTEGER,
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    switches INTEGER NOT NULL DEFAULT 0,
    hidden_ms INTEGER NOT NULL DEFAULT 0,
    anomalous INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_exam_sessions_user ON exam_sessions(user_id, started_at);
`);
{
  const cols = new Set(db.db.prepare(`PRAGMA table_info(exam_sessions)`).all().map(c => c.name));
  for (const [name, def] of [['switches', 'INTEGER NOT NULL DEFAULT 0'], ['hidden_ms', 'INTEGER NOT NULL DEFAULT 0'], ['anomalous', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!cols.has(name)) db.db.exec(`ALTER TABLE exam_sessions ADD COLUMN ${name} ${def}`);
  }
}

// Build the exam question pool from the 考证 course (electrician_exam) — every
// graded TF/MC node across s1-s13, tagged with its source lesson so results and
// mistakes can be attributed back for SM-2 and p-value stats.
function loadExamPool() {
  const pool = [];
  const index = readJSON(path.join(COURSES_DIR, 'index.json'));
  const course = index.find(c => c.id === 'electrician_exam');
  if (!course) return pool;
  for (const unit of course.units || []) {
    const unitPath = path.join(COURSES_DIR, course.id, `${unit.id}.json`);
    if (!fs.existsSync(unitPath)) continue;
    const data = readJSON(unitPath);
    for (const lesson of data.lessons || []) {
      const lessonId = `${course.id}/${unit.id}/${lesson.id}`;
      for (const node of lesson.nodes || []) {
        if (node.type === 'true_false' || node.type === 'multiple_choice') {
          pool.push({ ...node, _lessonId: lessonId });
        }
      }
    }
  }
  return pool;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Client copy must NOT leak correct answers: strip is_correct / correct_answer
// and anything the exam doesn't present (correct answers only reappear in the
// post-submit review, which is server-provided).
function sanitizeForClient(node) {
  const copy = { ...node };
  delete copy._lessonId;
  delete copy.explanation;
  delete copy.correct_answer;
  delete copy.answer;
  delete copy.acceptable_answers;
  delete copy.correct_order;
  delete copy.correct_probes;
  delete copy.correct_setup;
  delete copy.target;
  delete copy.correct_display;
  delete copy.hotspots;
  delete copy.dial_options;
  if (Array.isArray(copy.options)) {
    copy.options = copy.options.map(({ is_correct, ...rest }) => rest);
  }
  return copy;
}

// POST /api/exam/start — generate a fresh exam session. ?mode=real|training
router.post('/start', requireAuth, (req, res) => {
  const mode = resolveMode(req);
  const { minutes, counts } = EXAM_MODES[mode];
  const course = loadExamPool();
  const tfs = course.filter(n => n.type === 'true_false');
  const mcs = course.filter(n => n.type === 'multiple_choice');
  let mss = [];
  if (counts.multi_select > 0 && fs.existsSync(MS_POOL)) {
    mss = readJSON(MS_POOL).map(n => ({ ...n, _lessonId: 'exam/ms_pool' }));
  }
  const questions = [
    ...shuffle(tfs).slice(0, counts.true_false),
    ...shuffle(mcs).slice(0, counts.multiple_choice),
    ...shuffle(mss).slice(0, counts.multi_select),
  ];
  // Anti-cheat (60-agent round 2): the multi-select pool's correct answers all
  // sit at A/B, so a blind "check first two boxes" scores 10/10 on that section.
  // The client shuffles display order too, but the SERVER now shuffles option
  // order AND remaps every option's id to a fresh random value per session —
  // grading is id-based (the client submits o.id and the pool's correct ids are
  // always {A,B}), so a hand-rolled client submitting the literal ["A","B"] used
  // to win 10/10 every time. With per-session random ids the correct set moves,
  // and a blind fixed-id submission hits it only ~1/45. Options are deep-copied
  // before remapping so the shared pool (and stored mistake cards, which reload
  // the pool node by its REAL id) keep their canonical ids.
  for (const q of questions) {
    if (q.type === 'multi_select' && Array.isArray(q.options)) {
      q.options = shuffle(q.options).map(o => ({
        ...o,
        id: `ms-${crypto.randomBytes(4).toString('hex')}`,
      }));
    }
  }
  if (questions.length < 100) {
    return res.status(500).json({ error: `题库不足: 仅 ${questions.length}/100 题` });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + minutes * 60 * 1000);
  // Expire stale active sessions, run DB hygiene, and insert the new session in
  // ONE transaction (P29): previously each statement autocommitted separately, so
  // a failure after the expire-UPDATE but before the INSERT stranded the user
  // (old session gone, no replacement), and two concurrent /start calls could
  // leave two live sessions. All-or-nothing now.
  db.db.transaction(() => {
    // A user holds at most one live exam.
    db.db.prepare(
      `UPDATE exam_sessions SET status='expired' WHERE user_id = ? AND status = 'active'`
    ).run(req.userId);
    // DB hygiene (60-agent 性能审查): each session stores ~32KB questions_json,
    // and completed/expired rows were never purged — the table became the largest
    // in the DB. Drop finished sessions older than 30 days; live/active rows and
    // the last month of history stay.
    db.db.prepare(
      `DELETE FROM exam_sessions WHERE status IN ('completed','expired')
       AND created_at < datetime('now', '-30 days')`
    ).run();
    db.db.prepare(
      `INSERT INTO exam_sessions (id, user_id, started_at, expires_at, status, questions_json)
       VALUES (?, ?, ?, ?, 'active', ?)`
    ).run(id, req.userId, startedAt.toISOString(), expiresAt.toISOString(), JSON.stringify(questions));
  })();

  res.json({
    sessionId: id,
    mode,
    total: questions.length,
    minutes,
    passScore: EXAM_PASS_SCORE,
    expiresAt: expiresAt.toISOString(),
    questions: questions.map((q, i) => ({ ...sanitizeForClient(q), index: i })),
  });
});

// POST /api/exam/submit — server grades every answer, computes the score,
// records telemetry + SM-2 mistakes, and awards a first-pass-of-the-day bonus.
router.post('/submit', requireAuth, (req, res) => {
  const { sessionId, answers } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers array required' });
  // Malformed input guard (P29, mirrors the D4 guard in courses.js complete):
  // better-sqlite3 throws on non-scalar bindings (object/array userAnswer), and
  // that exception inside the rewards transaction would 500 the whole卷. Reject
  // non-scalar entries up front so a crafted client gets a clean 400 instead.
  const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  for (const a of answers) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return res.status(400).json({ error: 'answers entries must be objects' });
    }
    if ('index' in a && typeof a.index !== 'number') return res.status(400).json({ error: 'index must be a number' });
    if ('userAnswer' in a && !isScalar(a.userAnswer)) return res.status(400).json({ error: 'userAnswer must be a scalar value' });
  }

  const session = db.db.prepare(
    `SELECT * FROM exam_sessions WHERE id = ? AND user_id = ?`
  ).get(sessionId, req.userId);
  if (!session) return res.status(404).json({ error: '模拟考会话不存在或无权操作' });
  if (session.status !== 'active') {
    return res.status(409).json({ error: `会话已${session.status === 'completed' ? '交卷' : '过期'}` });
  }
  const now = Date.now();
  const expired = now > new Date(session.expires_at).getTime();
  // 防切屏异常（compare60 C04/C14）：切屏次数/累计离开时长达到阈值即标记。由 /track
  // 上报累计，交卷时一并判定。异常仍给 XP 与成绩，只扣发「当日首次通过」的 30 金币。
  const anomalous = session.switches >= ANOMALY_SWITCHES || session.hidden_ms >= ANOMALY_HIDDEN_MS;

  const questions = JSON.parse(session.questions_json);
  const answerByIndex = new Map(answers.map(a => [a.index, a]));
  const results = [];
  const mistakes = [];
  const nodeResults = [];
  let correctCount = 0;

  questions.forEach((node, i) => {
    const entry = answerByIndex.get(i);
    const userAnswer = entry?.userAnswer;
    const { gradeable, correct } = gradeNode(node, userAnswer);
    const isCorrect = gradeable ? correct : false;
    if (isCorrect) correctCount++;
    if (!isCorrect && entry) {
      mistakes.push({
        nodeId: node.id,
        lessonId: node._lessonId,
        type: node.type,
        question: node.question || '',
        userAnswer: userAnswer ?? '',
        correctAnswer: extractAnswer(node),
      });
    }
    nodeResults.push({ node, isCorrect, userAnswer });
    results.push({ index: i, correct: isCorrect, userAnswer: userAnswer ?? '', correctAnswer: extractAnswer(node) });
  });

  const total = questions.length;
  const score = Math.round((correctCount / total) * 100);
  const passed = score >= EXAM_PASS_SCORE && !expired;

  // Rewards + persistence in ONE transaction. XP/coins, mistakes, telemetry and
  // the status='completed' flip are atomic: if anything throws, everything rolls
  // back and the session stays 'active', so a client retry re-submits cleanly
  // instead of double-minting rewards (the 409 idempotency guard only helps once
  // the status flip has actually committed — previously XP/coins were written
  // before the flip and could be granted repeatedly on partial failures).
  let coinEarned = 0;
  let xpEarned = 0;
  const tx = db.db.transaction(() => {
    // firstPassToday must be computed BEFORE this pass commits, or this session
    // would count itself as an existing completed pass.
    const today = db.todayShanghai();
    const firstPassToday = db.db.prepare(
      `SELECT COUNT(*) c FROM exam_sessions
       WHERE user_id = ? AND status = 'completed' AND passed = 1 AND date(started_at, '+8 hours') = ?`
    ).get(req.userId, today).c === 0;

    // A passing (and on-time) attempt earns XP + coins on the FIRST pass of the
    // day; a genuine attempt earns a small effort XP, all daily-capped server-side.
    // A blank/all-wrong submission earns ZERO (mirrors the lesson-path gate: no
    // free +2 XP per empty payload).
    xpEarned = passed ? 30 : (correctCount > 0 ? 2 : 0);
    db.addLessonXP(req.userId, xpEarned);
    if (passed && firstPassToday && !anomalous) {
      coinEarned = 30;
      const state = db.getGameState(req.userId);
      db.updateGameState(req.userId, { coins: state.coins + 30 });
    }

    mistakes.forEach(m => {
      // node_index is irrelevant here (SM-2 looks up by node_id); use 0 as a
      // safe placeholder for the legacy fallback path.
      // C10: multi-select pool cards get a per-card option-id remap when stored.
      // The pool's option ids are constant {A,B,C,D} with correct ids always
      // {A,B}, so a review card that reloaded the pool node by its REAL id could
      // be blind-guessed ["A","B"] for a guaranteed correct grade → free coins.
      // Storing a fresh random remap (pool id → ms-xxxx) per card means review
      // re-grading sees a moved correct set; a fixed-id blind guess no longer
      // lands. loadMistakeNode applies remap_json (and generates one on first
      // load for pre-C10 legacy cards).
      let remapJson = null;
      if (m.lessonId === 'exam/ms_pool' && m.type === 'multi_select') {
        try {
          const pool = readJSON(MS_POOL);
          const poolNode = pool.find(n => n.id === m.nodeId);
          if (poolNode && Array.isArray(poolNode.options)) {
            const remap = {};
            for (const o of poolNode.options) {
              remap[String(o.id)] = `ms-${crypto.randomBytes(4).toString('hex')}`;
            }
            remapJson = JSON.stringify(remap);
          }
        } catch (e) {
          remapJson = null; // fall back to loadMistakeNode's on-load generation
        }
      }
      db.addMistake(req.userId, m.lessonId, m.nodeId, 0, m.question, m.userAnswer, m.correctAnswer, remapJson);
    });
    nodeResults.forEach(r => {
      // Attribute telemetry back to the SOURCE lesson so per-question p-values
      // aggregate across all exam attempts, not per-session fragments.
      db.addNodeResult(req.userId, r.node._lessonId, r.node, r.isCorrect, r.userAnswer, score);
    });

    db.db.prepare(
      `UPDATE exam_sessions SET status = 'completed', score = ?, total = ?, passed = ?, answers_json = ?, anomalous = ?
       WHERE id = ?`
    ).run(score, total, passed ? 1 : 0, JSON.stringify(answers), anomalous ? 1 : 0, sessionId);
  });
  tx();

  res.json({
    sessionId,
    score,
    total,
    passed,
    expired,
    anomalous,
    switches: session.switches,
    hiddenMs: session.hidden_ms,
    xpEarned,
    coinEarned,
    passScore: EXAM_PASS_SCORE,
    results,
  });
});

// POST /api/exam/track — 全真模式切屏上报（compare60 C04/C14）。客户端把每次
// 「切出→切回」累计成增量（switches 次 / hiddenMs 毫秒），周期性 POST 过来；服务端
// 增量落库并重算 anomalous。增量式：并发丢包只损失该次增量，不会把累计值翻倍。
// 真正的开卷（客户端干脆不上报）从浏览器端堵不死——这是威慑而非堡垒。
router.post('/track', requireAuth, rateLimit({ windowMs: 30 * 60 * 1000, max: 120, scope: 'exam-track' }), (req, res) => {
  const { sessionId, switches, hiddenMs } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const isNonNegInt = v => Number.isInteger(v) && v >= 0;
  const dSwitches = switches == null ? 0 : (isNonNegInt(switches) ? switches : NaN);
  const dHiddenMs = hiddenMs == null ? 0 : (isNonNegInt(hiddenMs) ? hiddenMs : NaN);
  if (Number.isNaN(dSwitches) || Number.isNaN(dHiddenMs)) {
    return res.status(400).json({ error: 'switches/hiddenMs 必须是非负整数' });
  }
  const s = db.db.prepare(`SELECT status FROM exam_sessions WHERE id = ? AND user_id = ?`).get(sessionId, req.userId);
  if (!s) return res.status(404).json({ error: '模拟考会话不存在或无权操作' });
  if (s.status !== 'active') return res.status(409).json({ error: `会话已${s.status === 'completed' ? '交卷' : '过期'}` });
  db.db.prepare(`UPDATE exam_sessions SET switches = switches + ?, hidden_ms = hidden_ms + ? WHERE id = ?`)
    .run(dSwitches, dHiddenMs, sessionId);
  const row = db.db.prepare(`SELECT switches, hidden_ms, anomalous FROM exam_sessions WHERE id = ?`).get(sessionId);
  const curSwitches = row.switches, curHiddenMs = row.hidden_ms;
  const anomalous = curSwitches >= ANOMALY_SWITCHES || curHiddenMs >= ANOMALY_HIDDEN_MS;
  if (anomalous && !row.anomalous) db.db.prepare(`UPDATE exam_sessions SET anomalous = 1 WHERE id = ?`).run(sessionId);
  res.json({ sessionId, switches: curSwitches, hiddenMs: curHiddenMs, anomalous });
});

// GET /api/exam/history — recent sessions (for a results page).
router.get('/history', requireAuth, (req, res) => {
  const rows = db.db.prepare(
    `SELECT id, started_at, expires_at, status, score, total, passed
     FROM exam_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 20`
  ).all(req.userId);
  res.json({ sessions: rows });
});

module.exports = router;
