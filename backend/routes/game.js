const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../models/database');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate_limit');
const { ITEM_CATALOG, applyItemEffect } = require('../lib/shop');
const { gradeNode } = require('../lib/grading');
const { readJSON, changeKey } = require('../lib/content_cache');

const COURSES_DIR = path.join(__dirname, '..', 'data', 'courses');
const INDEX_PATH = path.join(COURSES_DIR, 'index.json');

// Whitelist of real course ids → unit ids from the course index (same guard as
// courses.js: crafted lesson_id parts can't escape the course data dirs).
// Refreshed lazily when index.json changes so runtime-added courses/units are
// picked up without a restart (was frozen at module load — hot-add 404'd).
let _idxKey = null;
let COURSE_IDS = new Set();
let UNIT_IDS = new Map();

function refreshWhitelistIfChanged() {
  if (!fs.existsSync(INDEX_PATH)) return;
  const key = changeKey(INDEX_PATH);
  if (key === _idxKey) return;
  _idxKey = key;
  const index = readJSON(INDEX_PATH);
  COURSE_IDS = new Set(index.map(c => c.id));
  UNIT_IDS = new Map(index.map(c => [c.id, new Set((c.units || []).map(u => u.id))]));
}

function loadLesson(courseId, unitId, lessonId) {
  refreshWhitelistIfChanged();
  if (!COURSE_IDS.has(courseId)) return null;
  if (!UNIT_IDS.get(courseId)?.has(unitId)) return null;
  const unitPath = path.join(COURSES_DIR, courseId, `${unitId}.json`);
  if (!fs.existsSync(unitPath)) return null;
  const unit = readJSON(unitPath);
  if (!unit || !unit.lessons) return null;
  return unit.lessons.find(l => l.id === lessonId) || null;
}

// Resolve the node a mistake card points at, handling BOTH normal course lessons
// and the standalone multi-select exam pool. Exam pool questions are stored with
// lesson_id 'exam/ms_pool' ('exam' is not a real course, so loadLesson returns
// null and the card used to be auto-dismissed as an orphan — never graded, never
// reviewable). Pool node ids are unique (exam_ms_*), so look up by node_id.
const MS_POOL_PATH = path.join(__dirname, '..', 'data', 'exam', 'multi_select.json');
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Strip the answer out of a mistake card BEFORE it leaves the server (crosscheck3
// P26/P31 P1): GET /mistakes used to ship the full correct answer — row column
// AND original_node with correct_answer/answer/acceptable_answers/explanation and
// per-option is_correct. Combined with the then-unlimited /mistakes/review +
// /practice-heal, a script could read the answer, replay it into the review, and
// mint coins/hearts for free. A mistake card is a recall exercise: the answer is
// now revealed ONLY in the POST /mistakes/review response, after the user has
// committed an attempt. Kept on the node (they're render/self-grade inputs, not
// secrets the client can't already derive from its own UI): multimeter
// correct_setup/correct_display, drag_drop target_zone/distractors, dial_options
// labels. Abuse is bounded by the rate limits on review + practice-heal.
function sanitizeMistakeForClient(mistake, node) {
  const safe = { ...mistake };
  delete safe.correct_answer; // recall exercise: never hand the answer out up front
  if (!node) return safe;
  const clean = JSON.parse(JSON.stringify(node));
  delete clean.correct_answer;
  delete clean.answer;
  delete clean.acceptable_answers;
  delete clean.explanation;
  delete clean.correct_order; // sort items still render; the ORDER is the answer
  if (Array.isArray(clean.options)) clean.options.forEach(o => delete o.is_correct);
  // C10: strip the remaining server-only answer keys. A crafted client used to
  // read these off GET /mistakes and replay them into /mistakes/review to mint
  // coins — the card is a recall exercise, so grading inputs (which double as
  // the answer) are revealed ONLY after a committed attempt. What stays are the
  // render/re-answer inputs: simulation_dial keeps its labels so the learner can
  // pick by knowledge, and multimeter_challenge keeps its target/hotspots so the
  // learner can redo the measurement (the component falls back to server grading
  // when correct_setup is absent).
  switch (clean.type) {
    case 'match':
      delete clean.pairs;              // the left=right sequence IS the answer
      break;
    case 'drag_drop':
      // grading compares the target label; keeping the zone OR the distractors
      // leaks that label as a pickable candidate, and a candidate-only card
      // (zone stripped) could never be mastered (the right label isn't among the
      // choices). Strip both so the card falls back to the text-input recall
      // path and can still be mastered from memory.
      delete clean.target_zone;
      delete clean.distractors;
      break;
    case 'simulation_dial':
      if (Array.isArray(clean.dial_options)) {
        clean.dial_options.forEach(o => { delete o.is_correct; delete o.is_wrong; });
      }
      break;
    case 'simulation_probe':
      delete clean.correct_probes;     // probe keys are the answer
      break;
    case 'multimeter_challenge':
      delete clean.correct_setup;      // the full setup IS the answer
      delete clean.correct_display;    // the reading IS the answer
      break;
  }
  safe.original_node = clean;
  return safe;
}
function loadMistakeNode(mistake) {
  const parts = (mistake.lesson_id || '').split('/');
  if (parts.length === 3) {
    const lesson = loadLesson(parts[0], parts[1], parts[2]);
    if (lesson && lesson.nodes) {
      return mistake.node_id
        ? lesson.nodes.find(n => n.id === mistake.node_id) || null
        : lesson.nodes[mistake.node_index] || null;
    }
  } else if (mistake.lesson_id === 'exam/ms_pool') {
    try {
      const pool = readJSON(MS_POOL_PATH);
      const base = mistake.node_id ? pool.find(n => n.id === mistake.node_id) || null : null;
      if (!base) return null;
      // C10: multi-select pool cards must NOT re-grade against the canonical pool
      // node — its option ids are constant {A,B,C,D} with correct ids always
      // {A,B}, so a review replaying the literal ["A","B"] scored 10/10 and minted
      // coins. Each card carries remap_json (pool id → random ms-xxxx, generated
      // at store time by exam.js, or lazily here for pre-C10 legacy cards): apply
      // it so the correct set moves per card and a fixed-id blind guess misses.
      if (base.type !== 'multi_select' || !Array.isArray(base.options)) return base;
      let remap = null;
      try { remap = mistake.remap_json ? JSON.parse(mistake.remap_json) : null; } catch (e) { remap = null; }
      if (!remap || typeof remap !== 'object' || Array.isArray(remap)) {
        remap = {};
        for (const o of base.options) remap[String(o.id)] = `ms-${crypto.randomBytes(4).toString('hex')}`;
        try {
          db.db.prepare('UPDATE mistakes SET remap_json = ? WHERE id = ?')
            .run(JSON.stringify(remap), mistake.id);
        } catch (e) { /* best-effort persistence */ }
      }
      const node = JSON.parse(JSON.stringify(base));
      node.options = shuffle(node.options.map(o => ({ ...o, id: remap[String(o.id)] || String(o.id) })));
      return node;
    } catch (e) { return null; }
  }
  return null;
}

// compare60 C07: 复习来源章节回链 —— 把每张错题卡解析成「来源章节」展示元数据
// （课程/单元/课时标题 + 跳转地址），前端一键回看讲义。readJSON 有 (mtime,size)
// 缓存，同一请求内对同源卡复用，不会 N+1 全量读盘。
function resolveMistakeSource(mistake) {
  const parts = (mistake.lesson_id || '').split('/');
  if (parts.length === 3) {
    const [courseId, unitId, lessonId] = parts;
    let courseTitle = null, unitTitle = null;
    try {
      const index = readJSON(INDEX_PATH);
      const course = (index || []).find(c => c.id === courseId);
      courseTitle = course ? course.title : null;
    } catch (e) { /* 课程目录缺失时仅缺课程名 */ }
    try {
      const unit = readJSON(path.join(COURSES_DIR, courseId, `${unitId}.json`));
      unitTitle = unit && unit.id ? unit.title : null;
    } catch (e) { /* 单元读盘失败不阻断 */ }
    const lesson = loadLesson(courseId, unitId, lessonId);
    return {
      kind: 'lesson', courseId, unitId, lessonId,
      courseTitle, unitTitle, lessonTitle: lesson ? lesson.title : null,
    };
  }
  if (mistake.lesson_id === 'exam/ms_pool') {
    return {
      kind: 'ms_pool', courseId: null, unitId: null, lessonId: null,
      courseTitle: '模拟考', unitTitle: '多选题训练', lessonTitle: '多选题池',
    };
  }
  return {
    kind: 'unknown', courseId: null, unitId: null, lessonId: null,
    courseTitle: null, unitTitle: null, lessonTitle: null,
  };
}

// GET /api/game/state — current user's game state (userId from token).
router.get('/state', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  if (!state) return res.status(404).json({ error: 'User not found' });
  res.json(state);
});

// POST /api/game/use-heart
router.post('/use-heart', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  if (state.hearts <= 0) {
    return res.status(400).json({ error: 'No hearts remaining', canPractice: true });
  }
  const newState = db.updateGameState(req.userId, { hearts: state.hearts - 1 });
  res.json(newState);
});

// POST /api/game/restore-heart
// The client's amount is never trusted: always restore exactly 1 heart (capped
// at max). This closes the "restore-heart 可写负数" minting hole where a crafted
// body could drive hearts negative or refill for free at arbitrary sizes.
// Additionally gated by a cooldown (per-user, persisted in game_state): hammering
// the endpoint can no longer farm unlimited free hearts every request.
const HEART_RESTORE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
router.post('/restore-heart', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  const lastRestore = state.last_heart_restore ? new Date(state.last_heart_restore).getTime() : 0;
  const remainingMs = lastRestore + HEART_RESTORE_COOLDOWN_MS - Date.now();
  if (remainingMs > 0) {
    return res.status(429).json({
      error: '补心冷却中，请稍后再试',
      retryAfterMs: remainingMs,
    });
  }
  const newHearts = Math.min(state.max_hearts, state.hearts + 1);
  const newState = db.updateGameState(req.userId, {
    hearts: newHearts,
    last_heart_restore: new Date().toISOString(),
  });
  res.json(newState);
});

// POST /api/game/practice-heal — mistake review reward: heal hearts AND grant coins.
// Server-authoritative: the reward comes from unclaimed correct reviews recorded
// by /mistakes/review (review_credit), NOT from the client's correctCount. A
// crafted client claiming 20 correct answers with zero reviews earns zero coins.
// Rate-limited per (IP, account): each claim mints coins + heals, so an
// answer-dumper replaying reviews needs this capped too (crosscheck3 P26/P31 P1).
const healLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: 'practice-heal',
  key: (req) => `${req.ip}|${req.userId}`,
});
router.post('/practice-heal', requireAuth, healLimit, (req, res) => {
  // Claim + grant in ONE transaction (C10): claiming review_credit and crediting
  // hearts/coins were two autocommitted steps, so a failure between them could
  // mark credit claimed while the reward silently dropped (or worse, a retry
  // double-healed under partial state). Atomic now — the reward either fully
  // lands or nothing changes and the client retries cleanly.
  const outcome = db.db.transaction(() => {
    const state = db.getGameState(req.userId);
    // Claim at most 20 units; surplus stays unclaimed for a later heal (no
    // silent discard).
    const reward = db.claimReviewCredit(req.userId, 20);
    const healAmount = Math.min(reward, state.max_hearts - state.hearts);
    const coinReward = reward * 10;
    const newState = db.updateGameState(req.userId, {
      hearts: state.hearts + healAmount,
      coins: state.coins + coinReward,
    });
    return { newState, heartsRestored: healAmount, coinsEarned: coinReward };
  })();
  res.json({ ...outcome.newState, heartsRestored: outcome.heartsRestored, coinsEarned: outcome.coinsEarned });
});

// GET /api/game/mistakes — current user's due (SM-2 scheduled) mistakes.
// Tiered queue (B58 A6/F3): new learning-step cards and overdue reviews are
// drawn with separate caps inside getUnreviewedMistakes. `limit` (1..30,
// default 10) + `offset` paginate the combined queue.
router.get('/mistakes', requireAuth, (req, res) => {
  const rawLimit = parseInt(req.query.limit || '10', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 30) : 10;
  const rawOffset = parseInt(req.query.offset || '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const mistakes = db.getUnreviewedMistakes(req.userId, limit, offset);

  // Attach a SANITIZED node (answer keys stripped) if available. Address by the
  // stable node.id (globally unique, survives lesson reordering); legacy
  // node_index fallback covers rows created before node_id existed.
  // loadMistakeNode also resolves multi-select exam pool questions (lesson_id
  // 'exam/ms_pool'). Row-level correct_answer is stripped too — the answer is
  // only revealed by POST /mistakes/review after the user commits.
  // compare60 C03: approximate retrievability（遗忘风险）随卡下发 —— 前端展示
  // 「预测记得概率」，也供客户端按风险理解队列顺序。R = 0.9^(overdue/interval)，
  // 未排期/未到期返回 null（前端显示「新卡」不虚报概率）。
  // compare60 C07: 来源章节回链 —— 附上课程/单元/课时标题，前端一键回看讲义。
  const today = db.todayShanghai();
  const sourceCache = new Map();
  const enrichedMistakes = mistakes.map(mistake => {
    try {
      const node = loadMistakeNode(mistake);
      const safe = sanitizeMistakeForClient(mistake, node);
      safe.retrievability = db.computeRetrievability(mistake, today);
      if (!sourceCache.has(mistake.lesson_id)) sourceCache.set(mistake.lesson_id, resolveMistakeSource(mistake));
      safe.source = sourceCache.get(mistake.lesson_id);
      return safe;
    } catch(e) {
      const safe = sanitizeMistakeForClient(mistake, null);
      safe.retrievability = db.computeRetrievability(mistake, today);
      if (!sourceCache.has(mistake.lesson_id)) sourceCache.set(mistake.lesson_id, resolveMistakeSource(mistake));
      safe.source = sourceCache.get(mistake.lesson_id);
      return safe;
    }
  });

  res.json({ mistakes: enrichedMistakes, dueCount: db.getDueMistakeCount(req.userId) });
});

// GET /api/game/mistakes/due-count — how many cards are due today.
router.get('/mistakes/due-count', requireAuth, (req, res) => {
  res.json({ dueCount: db.getDueMistakeCount(req.userId) });
});

// compare60 C07: 错题集 Anki 兼容导出 —— 用户自己全部错题（含已掌握）的 TSV 下载。
// 数据仅限本人（requireAuth + getAllMistakes 按 userId 过滤，绝不越权）。「正确答案」
// 列取的是复习接口在提交后才揭示的同一份 extractAnswer 输出（入库时快照），对卡片主
// 人来说这些答案在学习阶段本已可见（lesson GET 鉴权下带答案键，CLAUDE.md 已知取舍），
// 因此不新增泄漏面；脱敏测试只约束 GET /mistakes 这条复习答题接口，不受影响。
// Anki 文件头 3 行（#separator/#html/#deck）后字段顺序 = Anki 字段顺序。
router.get('/mistakes/export', requireAuth, (req, res) => {
  const rows = db.getAllMistakes(req.userId);
  const sourceCache = new Map();
  const lines = [
    '#separator:tab',
    '#html:false',
    '#deck:DLG 错题',
    '题干\t正确答案\t来源\tRepetitions\tEase\tInterval(天)\t下次复习\t最后判定',
  ];
  for (const row of rows) {
    if (!sourceCache.has(row.lesson_id)) sourceCache.set(row.lesson_id, resolveMistakeSource(row));
    const src = sourceCache.get(row.lesson_id);
    const srcText = src.kind === 'lesson'
      ? [src.courseTitle, src.unitTitle, src.lessonTitle].filter(Boolean).join(' · ')
      : [src.courseTitle, src.lessonTitle].filter(Boolean).join(' · ');
    const verdict = row.last_verdict === null ? '未复习' : (row.last_verdict === 1 ? '对' : '错');
    const fields = [
      row.question_text || '',
      row.correct_answer || '',
      srcText,
      String(row.review_count ?? 0),
      row.easiness != null ? Number(row.easiness).toFixed(2) : '2.50',
      String(row.interval_days ?? 0),
      row.next_review_date || '',
      verdict,
    ];
    // TSV 转义：字段内的制表符/换行替换为空格，避免破坏列结构。
    lines.push(fields.map(f => String(f).replace(/[\t\r\n]+/g, ' ')).join('\t'));
  }
  // BOM：Excel 正确识别 UTF-8 中文；Content-Disposition 触发下载。
  const body = '﻿' + lines.join('\n');
  const safeId = String(req.userId).replace(/[^\w-]/g, '');
  res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dlg_mistakes_${safeId.slice(0, 8)}.tsv"`);
  res.send(body);
});

// GET /api/game/mistakes/stats — 当前用户复习侧进度追踪（留存率 + 7 天到期预报）。
// 纯聚合端点：overall/young-mature 留存率（review_log）、卡池总览、未来 7 天
// 到期预报。owner-scoped（requireAuth 用 token 推导 user_id），不返回任何
// 答案键/他人数据，与错题导出同一隔离边界。
router.get('/mistakes/stats', requireAuth, (req, res) => {
  res.json(db.getMistakeStats(req.userId));
});

// POST /api/game/mistakes/review — record a recall outcome (SM-2 scheduling).
// Body: { mistakeId, userAnswer }. The SERVER re-grades the recalled answer
// against the stored node's grading logic — the client's correct boolean is
// never trusted (a crafted client used to claim correct:true with zero
// knowledge and mint coins via review_credit). SM-2 runs on the server
// verdict; practice-heal credit is granted ONLY on a server-verified correct
// answer. Ownership-scoped. The response is the ONE place the correct answer is
// revealed — GET /mistakes ships sanitized cards (no answer keys), so a script
// can't read the answer up front and replay it (crosscheck3 P26/P31 P1).
// Rate-limited per (IP, account) so an answer-dumper can't hammer reviews.
const reviewLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  scope: 'mistake-review',
  key: (req) => `${req.ip}|${req.userId}`,
});
router.post('/mistakes/review', requireAuth, reviewLimit, (req, res) => {
  const { mistakeId, userAnswer } = req.body;
  if (!mistakeId) {
    return res.status(400).json({ error: 'mistakeId required' });
  }
  if (typeof userAnswer !== 'string' || userAnswer.trim() === '') {
    return res.status(400).json({ error: 'userAnswer (string) required for server re-grade' });
  }

  const mistake = db.getMistake(mistakeId, req.userId);
  if (!mistake) return res.status(404).json({ error: '错题不存在或无权操作' });

  // Re-grade against the stored node when it can still be loaded (regular
  // lessons AND the multi-select exam pool — loadMistakeNode handles both).
  let correct = null;   // null ⇒ unverifiable
  let nodeFound = false;
  try {
    const node = loadMistakeNode(mistake);
    if (node) {
      nodeFound = true;
      const verdict = gradeNode(node, userAnswer);
      correct = verdict.gradeable ? verdict.correct : null;
    }
  } catch (e) {
    correct = null;
  }

  // Orphaned card: the node no longer exists in course data, so this review can
  // never be server-graded. Dismiss it (mastered) rather than rescheduling it
  // tomorrow forever — that was the "永无法 mastered" dead-end that silently
  // blocked the mistake medical pack.
  if (!nodeFound) {
    db.dismissMistake(mistakeId, req.userId);
    return res.json({
      success: true,
      dismissed: true,
      serverGraded: false,
      correct: false,
      relearnInSession: false,
      correctAnswer: null,
      mistake: { id: mistakeId, mastered: true, interval_days: 0, next_review_date: null },
    });
  }

  const grantCredit = correct === true; // only a server-verified correct answer earns practice-heal credit
  const updated = db.reviewMistake(mistakeId, req.userId, correct ?? false, grantCredit, {
    // Optional client telemetry (B58 A2): written to review_log for retention
    // stats. Never trusted for rewards/credit — scheduling data only.
    responseTimeMs: typeof req.body.responseTimeMs === 'number' && Number.isFinite(req.body.responseTimeMs)
      ? Math.max(0, Math.round(req.body.responseTimeMs)) : undefined,
    sessionId: typeof req.body.sessionId === 'string' ? req.body.sessionId.slice(0, 64) : undefined,
    // compare60 C03/C07：判对后的自评难度（hard/good/easy），激活 SM-2 easiness 字段
    grade: ['hard', 'good', 'easy'].includes(req.body.grade) ? req.body.grade : undefined,
  });
  if (!updated) return res.status(404).json({ error: '错题不存在或无权操作' });
  res.json({
    success: true,
    serverGraded: correct !== null,
    correct: correct === true,       // server verdict (authoritative for the result phase)
    relearnInSession: correct === false, // B58 A4: failed recall should re-enter the session for immediate relearning
    correctAnswer: updated.correct_answer ?? null, // revealed only AFTER a committed attempt
    mistake: {
      id: updated.id,
      mastered: updated.mastered === 1,
      interval_days: updated.interval_days,
      next_review_date: updated.next_review_date,
    },
  });
});

// POST /api/game/spend-coins — purchase validated against the SERVER catalog.
// Price comes from ITEM_CATALOG, never from the request body (no client minting).
router.post('/spend-coins', requireAuth, (req, res) => {
  const { itemId } = req.body;
  const item = ITEM_CATALOG[itemId];
  if (!item) return res.status(400).json({ error: '未知道具' });

  const state = db.getGameState(req.userId);
  if (state.coins < item.price) {
    return res.status(400).json({ error: 'Insufficient coins' });
  }

  const newState = db.updateGameState(req.userId, { coins: state.coins - item.price });
  applyItemEffect(db, req.userId, itemId);

  // Accumulate quantity: UNIQUE(user_id, item_id) + upsert.
  db.db.prepare(`
    INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, 1)
    ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = quantity + 1
  `).run(req.userId, itemId);

  res.json({
    ...db.getGameState(req.userId),
    itemId,
    itemName: item.name,
    inventory: db.getInventory(req.userId),
  });
});

// GET /api/game/leaderboard/:league
// Optional auth: if a valid token is provided, the user's own league info is returned.
router.get('/leaderboard/:league', optionalAuth, (req, res) => {
  const requestedLeague = req.params.league;
  const userId = req.userId || null;
  const state = userId ? db.getGameState(userId) : null;
  const userLeague = state?.league || null;

  if (userId && userLeague === requestedLeague) {
    const info = db.getLeagueInfo(userId);
    return res.json({
      ...info,
      is_my_league: true,
      viewer_league: userLeague,
    });
  }

  const real = db.getLeaderboard(requestedLeague, 10);
  const ws = db.getWeekStart();
  const ghosts = db.generateGhostLeaderboard(requestedLeague, 0, Math.max(0, 10 - real.length), ws);
  const combined = [...real, ...ghosts]
    .sort((a, b) => b.xp_earned - a.xp_earned)
    .slice(0, 10)
    .map((e, i) => ({ ...e, rank: i + 1 }));
  res.json({
    entries: combined,
    league: requestedLeague,
    week_start: ws,
    week_ends_at: db.getWeekEndsAt(),
    is_my_league: false,
    viewer_league: userLeague,
    my_rank: null,
    my_xp: null,
  });
});

// GET /api/game/league/info — requires auth.
router.get('/league/info', requireAuth, (req, res) => {
  const info = db.getLeagueInfo(req.userId);
  if (!info) return res.status(404).json({ error: 'user not found' });
  res.json(info);
});

// GET /api/game/league/history — current user's history.
router.get('/league/history', requireAuth, (req, res) => {
  // Validate limit: a crafted ?limit=abc used to produce NaN → SQLite LIMIT NaN
  // → 500. Clamp to a sane 1..52, defaulting to 12.
  const raw = parseInt(req.query.limit || '12', 10);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 52) : 12;
  const rows = db.db.prepare(`
    SELECT * FROM league_history WHERE user_id = ? ORDER BY week_start DESC LIMIT ?
  `).all(req.userId, limit);
  res.json(rows);
});

// POST /api/game/league/claim-reward — 领取最新已结算未领取的段位奖励（crosscheck6 C high：
// settleWeek 置 final_rank/tier_change/settled_at，reward_claimed 由这里原子置 1 + 发币）。
router.post('/league/claim-reward', requireAuth, (req, res) => {
  const reward = db.claimLeagueReward(req.userId);
  if (!reward) return res.json({ claimed: false, reward: null, message: '没有可领取的段位奖励' });
  res.json({ claimed: true, reward });
});

// POST /api/game/league/_admin/settle — ADMIN ONLY. Prevents unauthorized week
// force-settlement. Rate-limited per IP (C5): with force:true this rewrites
// every user's rank/league, so an online-brute-forced weak ADMIN_TOKEN must not
// get unlimited tries.
router.post('/league/_admin/settle',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, scope: 'admin' }),
  requireAdmin, (req, res) => {
  try {
    const result = db.settleWeek(req.body?.weekStart || null, req.body?.force === true);
    res.json(result);
  } catch (e) {
    // Never echo the raw exception (P31): it can leak SQL/DB internals. The
    // full stack is already logged server-side by settleWeek.
    console.error('[settle] failed:', e);
    res.status(500).json({ error: '结算失败，请稍后重试' });
  }
});

// GET /api/game/streak — current user.
// "today" is Asia/Shanghai, NOT UTC: a Shanghai user checking in between local
// midnight (16:00 UTC) and 08:00 local used to see a UTC-future date and get
// flagged needsCheckin on an already-checked-in day, silently breaking streaks.
router.get('/streak', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  const today = db.todayShanghai();
  res.json({
    streak: state.streak,
    lastDate: state.last_streak_date,
    today,
    needsCheckin: state.last_streak_date !== today,
  });
});

// POST /api/game/checkin
router.post('/checkin', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  const today = db.todayShanghai();

  if (state.last_streak_date === today) {
    return res.json({ streak: state.streak, alreadyCheckedIn: true });
  }

  const yesterday = db.daysAgoShanghai(1);
  let newStreak;
  if (state.last_streak_date === yesterday) {
    newStreak = state.streak + 1;
  } else {
    if (state.freeze_item_count > 0 && state.last_streak_date) {
      db.updateGameState(req.userId, { freeze_item_count: state.freeze_item_count - 1 });
      newStreak = state.streak + 1;
    } else {
      newStreak = 1;
    }
  }

  const coinBonus = Math.min(newStreak * 10, 100);
  const newState = db.updateGameState(req.userId, {
    streak: newStreak,
    last_streak_date: today,
    coins: state.coins + coinBonus,
  });

  res.json({ ...newState, coinBonus });
});

module.exports = router;
