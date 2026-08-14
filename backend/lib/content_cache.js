// Content JSON read cache (60-agent 性能审查): every /courses and /game
// request re-read and re-parsed the full unit files from disk (largest unit
// u10_opamp_dynamics.json = 830KB → 2–3ms of blocking JSON.parse per request;
// /game/mistakes did N+1 unit reads per mistake). Content files only change
// when an editor swaps them, so cache by (path, mtimeMs, size): stat() is ~µs,
// and an editor write bumps mtime → next request re-reads and refreshes.
// `size` is part of the key because a write landing in the SAME millisecond as
// the previous one returns the same mtimeMs — without size, the cache would
// keep serving the first version (60-agent round 2: ~41% stale on rapid edits).
// In-memory (per process) — fine for a single-server deployment.
'use strict';

const fs = require('fs');

const cache = new Map(); // absPath -> { mtimeMs, size, data }

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
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

// Force-refresh for explicit invalidation if ever needed (not used by routes).
function invalidate(filePath) {
  cache.delete(filePath);
}

// Change-signature of a file (mtimeMs + size), stable until the file actually
// changes. Callers that derive in-memory structures from a file (e.g. the
// course-id whitelists) compare this key and only rebuild when it moves — that
// way a runtime edit to index.json (new course/unit) is picked up instead of
// being frozen at module load.
function changeKey(filePath) {
  const st = fs.statSync(filePath);
  return `${st.mtimeMs}:${st.size}`;
}

module.exports = { readJSON, invalidate, changeKey };
