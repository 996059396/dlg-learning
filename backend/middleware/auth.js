// Auth middleware: resolves the authenticated user from the bearer token.
// Every user-scoped endpoint must derive userId from the token, NEVER from
// client-supplied body/params/query (fixes the 零鉴权 IDOR P0).
const crypto = require('crypto');
const db = require('../models/database');

function extractToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

// 401 if no valid session.
function requireAuth(req, res, next) {
  const user = db.getUserByToken(extractToken(req));
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.userId = user.id;
  req.user = user;
  next();
}

// Sets req.userId when a valid token is present; never rejects.
function optionalAuth(req, res, next) {
  const user = db.getUserByToken(extractToken(req));
  if (user) {
    req.userId = user.id;
    req.user = user;
  }
  next();
}

// Admin gate for privileged endpoints (settlement).
// ADMIN_TOKEN must come from the environment — NO default value (an old public
// default value was a live backdoor; now fail-closed 503 when unset). Constant-time compare.
function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(503).json({ error: '服务端未配置 ADMIN_TOKEN' });
  }
  const supplied = String(req.headers['x-admin-token'] || '').trim();
  if (supplied) {
    const a = Buffer.from(adminToken);
    const b = Buffer.from(supplied);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) return next();
  }
  // Allow an authenticated user marked admin (future-proof).
  const user = db.getUserByToken(extractToken(req));
  if (user && process.env.ADMIN_USER_ID && user.id === process.env.ADMIN_USER_ID) {
    next();
    return;
  }
  return res.status(403).json({ error: '无权访问' });
}

module.exports = { requireAuth, optionalAuth, requireAdmin, extractToken };
