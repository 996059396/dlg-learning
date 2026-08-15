// In-memory fixed-window rate limiter (60-agent 安全审查 C5): login/register
// had no throttling — a bot (or a crafted client) could hammer scryptSync for a
// CPU DoS and brute-force weak passwords at full speed, and the admin settle
// endpoint had the same hole. Windowed per (key, scope); window is a simple
// counter bucket (not sliding) — good enough here. In-memory ⇒ counters reset
// on restart; fine for a single-server LAN/small-scale deployment. No deps.
'use strict';

const buckets = new Map(); // `${scope}:${key}` -> { count, resetAt }

// P25 #3: the bucket Map previously only ever grew — login success cleared just
// the per-account bucket, so auth-ip/register/admin buckets persisted until a
// restart. A distributed (IP,username) storm would slowly leak memory. Purge
// expired entries every minute; if the Map still exceeds a hard cap, evict the
// soonest-to-expire entries first. unref() so the timer never holds the process
// open. (Under an active flood the cap's memory protection outweighs the tiny
// reset-window a capped eviction gives a bucket key; it only ever engages at
// 10000+ distinct keys within one minute.)
const MAX_BUCKETS = 10000;
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  if (buckets.size > MAX_BUCKETS) {
    const entries = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [k] of entries.slice(0, buckets.size - MAX_BUCKETS)) buckets.delete(k);
  }
}, 60 * 1000).unref();

/**
 * Fixed-window rate limiter factory.
 * @param {object} opts
 * @param {number} opts.windowMs  window length in ms
 * @param {number} opts.max       max allowed requests per window
 * @param {string} opts.scope     bucket scope prefix (e.g. 'login', 'admin')
 * @param {function(import('express').Request): string} [opts.key]
 *   returns the bucket key (defaults to client IP). Use a username key for
 *   per-account lockout on top of the IP bucket.
 */
function rateLimit({ windowMs, max, scope, key = (req) => req.ip }) {
  // Scope-prefixed env override (DLG_RATE_MAX_<scope>): the self-contained API
  // suite boots this server on an isolated DB and registers/logs in dozens of
  // throwaway accounts in one run — a shared per-IP 'auth-ip' bucket of 20 would
  // 429 mid-suite. Prod never sets these vars → unchanged behavior. The
  // per-account 'login-user' and 'admin' buckets are left at their prod limits
  // so their lockout tests stay meaningful.
  const envMax = process.env[`DLG_RATE_MAX_${scope}`];
  const effMax = envMax ? Number(envMax) : max;
  return (req, res, next) => {
    const k = `${scope}:${key(req)}`;
    const now = Date.now();
    const b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      buckets.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    b.count++;
    if (b.count <= effMax) return next();
    const retryAfterMs = b.resetAt - now;
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({ error: '请求过于频繁，请稍后再试', retryAfterMs });
  };
}

function clearBucket(key) {
  buckets.delete(key);
}

module.exports = { rateLimit, clearBucket };
