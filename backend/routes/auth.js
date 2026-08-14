const express = require('express');
const router = express.Router();
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, clearBucket } = require('../middleware/rate_limit');
const { v4: uuidv4 } = require('uuid');

// Per-IP + per-account throttles (C5): scryptSync blocks the event loop ~34ms
// per failed attempt and there was no lockout at all — infinite online brute
// force + CPU DoS. IP bucket is coarse (20/15min) to survive NAT'd LANs; the
// per-username bucket locks a specific account after 5 failed logins regardless
// of source. A successful login resets the account bucket so a legit user isn't
// stuck behind their own earlier mistakes.
const ipAuthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, scope: 'auth-ip' });
const usernameLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  scope: 'login-user',
  key: (req) => String(req.body?.username || '').trim().toLowerCase() || '?',
});

// GET /api/auth/me — returns the AUTHENTICATED user (no more "first user").
router.get('/me', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  res.json({ ...req.user, ...state });
});

// POST /api/auth/register — create user + game_state, issue session token.
// password is REQUIRED (>= 6 chars) so every account is recoverable via login.
// Legacy password-less accounts still work via existing sessions, but cannot be
// re-created this way. Rate-limited per IP (C5).
router.post('/register', ipAuthLimit, (req, res) => {
  const { username, password } = req.body;
  const name = String(username || '').trim().slice(0, 24) || '新学员';
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  // App-level uniqueness check (works even on legacy DBs where the UNIQUE
  // index could not be created due to pre-existing duplicates).
  if (db.db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
    return res.status(409).json({ error: '用户名已被占用' });
  }
  const userId = uuidv4();
  try {
    db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(userId, name);
  } catch (e) {
    // Race on a freshly-added UNIQUE index — treat as taken.
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '用户名已被占用' });
    throw e;
  }
  db.db.prepare('INSERT INTO game_state (user_id) VALUES (?)').run(userId);
  db.setUserPassword(userId, password);
  const token = db.createSession(userId);
  const user = db.getUser(userId);
  res.json({ user, token });
});

// POST /api/auth/login — password check, issue session token.
// Rate-limited per IP AND per username: 5 failed logins for one account locks
// that account for 15 min; success clears the account's counter (C5).
router.post('/login', ipAuthLimit, usernameLoginLimit, (req, res) => {
  const { username, password } = req.body;
  const user = db.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (!db.verifyPassword(user.id, password)) {
    return res.status(401).json({ error: '密码错误' });
  }
  clearBucket(`login-user:${String(username || '').trim().toLowerCase() || '?'}`);
  const token = db.createSession(user.id);
  db.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const full = db.getUser(user.id);
  res.json({ user: full, token });
});

// POST /api/auth/logout — revoke current session.
router.post('/logout', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  db.deleteSession(token);
  res.json({ success: true });
});

module.exports = router;
