const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../models/database');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { ITEM_CATALOG, applyItemEffect } = require('../lib/shop');
const { gradeNode } = require('../lib/grading');

const COURSES_DIR = path.join(__dirname, '..', 'data', 'courses');

// Whitelist of real course ids → unit ids from the course index (same guard as
// courses.js: crafted lesson_id parts can't escape the course data dirs).
const _index = fs.existsSync(path.join(COURSES_DIR, 'index.json'))
  ? JSON.parse(fs.readFileSync(path.join(COURSES_DIR, 'index.json'), 'utf-8'))
  : [];
const COURSE_IDS = new Set(_index.map(c => c.id));
const UNIT_IDS = new Map(_index.map(c => [c.id, new Set((c.units || []).map(u => u.id))]));

function loadLesson(courseId, unitId, lessonId) {
  if (!COURSE_IDS.has(courseId)) return null;
  if (!UNIT_IDS.get(courseId)?.has(unitId)) return null;
  const unitPath = path.join(COURSES_DIR, courseId, `${unitId}.json`);
  if (!fs.existsSync(unitPath)) return null;
  const unit = JSON.parse(fs.readFileSync(unitPath, 'utf-8'));
  if (!unit || !unit.lessons) return null;
  return unit.lessons.find(l => l.id === lessonId) || null;
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
router.post('/practice-heal', requireAuth, (req, res) => {
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
  res.json({ ...newState, heartsRestored: healAmount, coinsEarned: coinReward });
});

// GET /api/game/mistakes — current user's due (SM-2 scheduled) mistakes.
router.get('/mistakes', requireAuth, (req, res) => {
  const mistakes = db.getUnreviewedMistakes(req.userId, 10);

  // Attach original node data if available. Address by the stable node.id
  // (globally unique, survives lesson reordering); legacy node_index fallback
  // covers rows created before node_id existed.
  const enrichedMistakes = mistakes.map(mistake => {
    try {
      const parts = mistake.lesson_id.split('/');
      if (parts.length === 3) {
        const lesson = loadLesson(parts[0], parts[1], parts[2]);
        if (lesson && lesson.nodes) {
          const node = mistake.node_id
            ? lesson.nodes.find(n => n.id === mistake.node_id)
            : lesson.nodes[mistake.node_index];
          if (node) mistake.original_node = node;
        }
      }
    } catch(e) {}
    return mistake;
  });

  res.json({ mistakes: enrichedMistakes, dueCount: db.getDueMistakeCount(req.userId) });
});

// GET /api/game/mistakes/due-count — how many cards are due today.
router.get('/mistakes/due-count', requireAuth, (req, res) => {
  res.json({ dueCount: db.getDueMistakeCount(req.userId) });
});

// POST /api/game/mistakes/review — record a recall outcome (SM-2 scheduling).
// Body: { mistakeId, userAnswer }. The SERVER re-grades the recalled answer
// against the stored node's grading logic — the client's correct boolean is
// never trusted (a crafted client used to claim correct:true with zero
// knowledge and mint coins via review_credit). SM-2 runs on the server
// verdict; practice-heal credit is granted ONLY on a server-verified correct
// answer. Ownership-scoped.
router.post('/mistakes/review', requireAuth, (req, res) => {
  const { mistakeId, userAnswer } = req.body;
  if (!mistakeId) {
    return res.status(400).json({ error: 'mistakeId required' });
  }
  if (typeof userAnswer !== 'string' || userAnswer.trim() === '') {
    return res.status(400).json({ error: 'userAnswer (string) required for server re-grade' });
  }

  const mistake = db.getMistake(mistakeId, req.userId);
  if (!mistake) return res.status(404).json({ error: '错题不存在或无权操作' });

  // Re-grade against the stored node when it can still be loaded.
  let correct = null;   // null ⇒ unverifiable
  let nodeFound = false;
  try {
    const parts = mistake.lesson_id.split('/');
    if (parts.length === 3) {
      const lesson = loadLesson(parts[0], parts[1], parts[2]);
      if (lesson && lesson.nodes) {
        const node = mistake.node_id
          ? lesson.nodes.find(n => n.id === mistake.node_id)
          : lesson.nodes[mistake.node_index];
        if (node) {
          nodeFound = true;
          const verdict = gradeNode(node, userAnswer);
          correct = verdict.gradeable ? verdict.correct : null;
        }
      }
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
      mistake: { id: mistakeId, mastered: true, interval_days: 0, next_review_date: null },
    });
  }

  const grantCredit = correct === true; // only a server-verified correct answer earns practice-heal credit
  const updated = db.reviewMistake(mistakeId, req.userId, correct ?? false, grantCredit);
  if (!updated) return res.status(404).json({ error: '错题不存在或无权操作' });
  res.json({
    success: true,
    serverGraded: correct !== null,
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

// POST /api/game/league/_admin/settle — ADMIN ONLY. Prevents unauthorized week force-settlement.
router.post('/league/_admin/settle', requireAdmin, (req, res) => {
  try {
    const result = db.settleWeek(req.body?.weekStart || null, req.body?.force === true);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
