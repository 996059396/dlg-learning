const express = require('express');
const router = express.Router();
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, clearBucket } = require('../middleware/rate_limit');
const { v4: uuidv4 } = require('uuid');

// Username canonical form (60-agent 安全审查): register/login matched raw bytes,
// so a full-width ａｌｉｃｅ or an invisible ZWSP variant slipped past the UNIQUE
// index and visually impersonated a real account. NFKC folds full-width → ASCII;
// control + zero-width chars are stripped so two "identical-looking" names are
// one. Applied everywhere a username enters the system (register, login, and the
// per-account rate-limit key).
const normalizeUsername = (raw) =>
  String(raw || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 24);

// Per-IP + per-account throttles (C5): scryptSync blocks the event loop ~34ms
// per failed attempt and there was no lockout at all — infinite online brute
// force + CPU DoS. IP bucket is coarse (20/15min) to survive NAT'd LANs; the
// per-(IP, account) bucket locks after 5 failed logins for that source AND
// account. Keying by IP+account (not account alone) is deliberate (60-agent #10):
// username-only keying let ANY remote client lock ANY account with 5 bad
// attempts (account-level DoS + username enumeration via distinct 401 bodies).
// A successful login clears the (IP, account) bucket so a legit user isn't
// stuck behind their own earlier mistakes.
const ipAuthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, scope: 'auth-ip' });
// register 独立桶 (P25 #1/#6): register/login/change-password 曾共用 auth-ip 桶
// (20/15min)——未认证者可借 register 409/200 枚举已占用用户名, 且同一 NAT 下用户
// 会互相踩桶。register 是低频操作, 独立并大幅收紧到 5/15min/IP, 枚举速率被封在
// 每 IP 每 15min 5 次, 同时消除 NAT 共用误伤。测试套件用 DLG_RATE_MAX_register 放开。
const registerIpLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, scope: 'register' });
const usernameLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  scope: 'login-user',
  key: (req) => `${req.ip}|${normalizeUsername(req.body?.username).toLowerCase()}`,
});
// 分布式撞锁兜底 (P25 #2): auth-ip 与 login-user 都只按 IP 计数——botnet/代理轮换
// IP 即可绕过两者。跨 IP 按用户名的全局失败上限作兜底: 上限取 20 (远高于 login-user
// 的 5), 保持 60-agent #10 的「不得让任意远端锁任意账号」决策, 同时把分布式暴力对
// 单账号的总尝试率封顶。成功登录清零, 避免真实用户被自己早前的失败卡住。
const globalUserLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  scope: 'login-user-global',
  key: (req) => normalizeUsername(req.body?.username).toLowerCase(),
});
// Per-(IP, account) cap on password changes (V06 P3): the per-IP bucket alone
// lets a single account's old password be brute-forced from a shared NAT IP.
// Keyed by IP+account (not account alone) so a remote client can't lock a user
// out of changing their own password.
const changePasswordLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: 'change-pw',
  key: (req) => `${req.ip}|${normalizeUsername(req.user?.username).toLowerCase()}`,
});

// GET /api/auth/me — returns the AUTHENTICATED user (no more "first user").
router.get('/me', requireAuth, (req, res) => {
  const state = db.getGameState(req.userId);
  res.json({ ...req.user, ...state });
});

// POST /api/auth/register — create user + game_state, issue session token.
// password is REQUIRED (>= 6 chars) so every account is recoverable via login.
// Legacy password-less accounts still work via existing sessions, but cannot be
// re-created this way. Independent, tighter rate-limit per IP (P25 #1): the
// 409/200 status split is inherently a username-existence oracle, so the 409
// body is a generic message and the register bucket is throttled to 5/15min/IP.
router.post('/register', registerIpLimit, (req, res) => {
  const { username, password } = req.body;
  const name = normalizeUsername(username) || '新学员';
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  // App-level uniqueness check (works even on legacy DBs where the UNIQUE
  // index could not be created due to pre-existing duplicates). Generic 409
  // body — do NOT confirm the username was the specific reason (P25 #1).
  if (db.db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
    return res.status(409).json({ error: '注册失败，请更换用户名' });
  }
  const userId = uuidv4();
  try {
    db.db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(userId, name);
  } catch (e) {
    // Race on a freshly-added UNIQUE index — treat as taken.
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '注册失败，请更换用户名' });
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
// that account for 15 min; success clears the account's counter (C5). A global
// cross-IP per-username backstop (20/15min) caps distributed brute force that
// rotates IPs to dodge the per-IP buckets (P25 #2).
router.post('/login', ipAuthLimit, usernameLoginLimit, globalUserLoginLimit, (req, res) => {
  const { username, password } = req.body;
  const uname = normalizeUsername(username);
  const user = db.db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  // Unified 401 body for "no such user" AND "wrong password" — an attacker must
  // not be able to distinguish registered usernames by the error message (user
  // enumeration, 60-agent #10). Timing still differs slightly, but the (IP,account)
  // + per-IP buckets cap the oracle.
  if (!user || !db.verifyPassword(user.id, password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  // Success: reset this (IP, account) AND the global per-username bucket so
  // prior failed attempts from any source don't linger against the legit login.
  clearBucket(`login-user:${req.ip}|${uname.toLowerCase()}`);
  clearBucket(`login-user-global:${uname.toLowerCase()}`);
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

// POST /api/auth/logout-all — revoke EVERY session for the user (60-agent 安全
// 审查 "会话无撤销"): stolen tokens in localStorage on any device die at once.
router.post('/logout-all', requireAuth, (req, res) => {
  db.deleteAllSessions(req.userId);
  res.json({ success: true });
});

// POST /api/auth/change-password — verify current password, set new one, then
// revoke all sessions so old tokens (including the one in this request) expire.
router.post('/change-password', ipAuthLimit, requireAuth, changePasswordLimit, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  if (!db.changePassword(req.userId, String(oldPassword || ''), newPassword)) {
    return res.status(401).json({ error: '原密码错误' });
  }
  res.json({ success: true });
});

module.exports = router;
