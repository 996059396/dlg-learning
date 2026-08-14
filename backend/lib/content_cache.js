// Content JSON read cache (60-agent 性能审查): every /courses and /game
// request re-read and re-parsed the full unit files from disk (largest unit
// u10_opamp_dynamics.json = 830KB → 2–3ms of blocking JSON.parse per request;
// /game/mistakes did N+1 unit reads per mistake). Content files only change
// when an editor swaps them, so cache by (path, mtimeMs): stat() is ~µs, and an
// editor write bumps mtime → next request re-reads and refreshes the cache.
// In-memory (per process) — fine for a single-server deployment.
'use strict';

const fs = require('fs');

const cache = new Map(); // absPath -> { mtimeMs, data }

function readJSON(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    // File gone — drop any stale entry and let the caller's error path handle it.
    cache.delete(filePath);
    throw e;
  }
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  cache.set(filePath, { mtimeMs: stat.mtimeMs, data });
  return data;
}

// Force-refresh for explicit invalidation if ever needed (not used by routes).
function invalidate(filePath) {
  cache.delete(filePath);
}

module.exports = { readJSON, invalidate };
