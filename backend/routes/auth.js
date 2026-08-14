const express = require('express');
const router = express.Router();
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// GET /api/auth/me — returns the AUTHENTICATED user (no more "first user").
router.get('/me', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  res.json({ ...req.user, ...state });
});

// POST /api/auth/register — create user + game_state, issue session token.
// password is REQUIRED (>= 6 chars) so every account is recoverable via login.
// Legacy password-less accounts still work via existing sessions, but cannot be
// re-created this way.
router.post('/register', (req, res) => {
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
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (!db.verifyPassword(user.id, password)) {
    return res.status(401).json({ error: '密码错误' });
  }
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
