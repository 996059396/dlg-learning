// ABI preflight (P0-2): better-sqlite3 v13 is prebuilt for Node ABI 137. On
// Node 20 (ABI 115) the require itself segfaults with no readable message, and
// this server runs under nohup/guard where a bare crash is invisible. Fail fast
// with guidance BEFORE any module that touches better-sqlite3 is loaded.
if (Number(process.versions.modules) !== 137) {
  console.error(`[fatal] Node ABI = ${process.versions.modules} (需要 137) — better-sqlite3 v13 预编译二进制不匹配，require 即段错误。`);
  console.error('[fatal] 请改用 Node 24 启动：C:\\Users\\moxo\\node24\\node.exe server.js');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const net = require('net');
const cron = require('node-cron');
const compression = require('compression');
const { initializeDatabase, settleWeek, catchUpSettlements, getWeekStart, db } = require('./models/database');

// Process-level safety net (D4): a startup failure (corrupt DB, unreadable
// index.json) used to exit 1 with a stack only in the terminal — invisible under
// nohup. Log a clear line, then fail fast so a process manager (pm2/nssm/
// systemd) can restart. Unhandled rejections are logged but non-fatal.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException — restart required:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[warn] unhandledRejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3001;
// Bind address: default 0.0.0.0 (LAN/mobile testing on the same network).
// Override with HOST=127.0.0.1 to restrict to loopback only.
const HOST = process.env.HOST || '0.0.0.0';

// Port mutex (P0-2): probe the port BEFORE opening app.db. A port already in
// use means another instance is running — exit cleanly instead of letting two
// instances open the same SQLite file and both write the WAL. The port is the
// cross-process lock; the probe must resolve before initializeDatabase() runs.
function portInUse(port, host) {
  return new Promise((resolve) => {
    const probe = new net.Socket();
    probe.setTimeout(800);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(false));
    probe.connect(port, host);
  });
}

// Trust proxies ONLY from loopback (e.g. a local cloudflared/cpolar tunnel).
// This lets rate limiting key off the REAL client IP via X-Forwarded-For when
// the app is reached through a tunnel — otherwise every tunneled request looks
// like 127.0.0.1 and the whole tunnel shares one auth-ip bucket. 'loopback'
// means a remote client can NOT spoof XFF to bypass the limiter (their
// connection arrives from a non-loopback source and is never trusted), and
// direct LAN access keeps using the actual peer IP.
app.set('trust proxy', 'loopback');

// CORS whitelist: default local dev origins; override via CORS_ORIGINS env (comma-separated).
const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'];
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || defaultOrigins.join(','))
    .split(',').map(s => s.trim()).filter(Boolean)
);

// Middleware
app.use(cors({
  origin(origin, cb) {
    // Allow same-origin (no Origin header) and whitelisted origins.
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
// Gzip/Brotli — biggest single perf win on mobile (audit: -64% on JSON payloads).
app.use(compression());
app.use(express.json());

// Serve the built frontend if present (P0 C — the dist was an orphan: the API
// never served it, so the production app had no host). In dev the Vite server
// still proxies; here the backend becomes the single origin for production.
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
const hasDist = fs.existsSync(path.join(frontendDist, 'index.html'));
if (hasDist) {
  // Hash-named assets (index-<hash>.js/css) are immutable → cache a year.
  // index.html is served separately with no-cache (D2): Vite empties dist on
  // rebuild, so a stale index.html pointing at a deleted hash asset caused a
  // 1-hour white screen for repeat visitors after every deploy.
  app.use(express.static(frontendDist, { maxAge: '1y', immutable: true, index: false }));
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log('[static] Serving frontend from', frontendDist);
}

async function main() {
  // Port mutex first (see portInUse above). If another instance holds the port,
  // bail out before any module opens app.db — no concurrent WAL writes.
  if (await portInUse(PORT, HOST)) {
    console.error(`[fatal] 端口 ${PORT} 已被占用 —— 疑似已有 DLG 实例在运行。退出，避免两个实例并发写 app.db。`);
    process.exit(1);
  }

  // Initialize database
  initializeDatabase();

  // Startup catch-up: settle any weeks missed while the server was offline
  // (cron only fires on Mondays 00:00; a downed server skips the boundary).
  try {
    const caughtUp = catchUpSettlements();
    if (caughtUp > 0) console.log(`[boot] Caught up ${caughtUp} missed settlement entries`);
  } catch (e) {
    console.error('[boot] Settlement catch-up failed:', e);
  }

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/game', require('./routes/game'));
app.use('/api/exam', require('./routes/exam'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// === Weekly settlement cron ===
// Mondays 00:00 Asia/Shanghai. node-cron supports timezone.
cron.schedule('0 0 * * 1', () => {
  console.log('[cron] Weekly settlement triggered');
  try {
    const result = settleWeek();
    console.log(`[cron] Settled week ${result.weekStart}: ${result.settled.length} entries`);
  } catch (e) {
    console.error('[cron] Settlement failed:', e);
  }
}, { timezone: 'Asia/Shanghai' });

console.log(`[cron] Weekly settlement scheduled (Mondays 00:00 Asia/Shanghai). Current week: ${getWeekStart()}`);

// === Daily DB backup (P0 清单: 每日备份 + 升级前快照) ===
// better-sqlite3 db.backup() 在 WAL 下产出一致性快照（纯 fs copy 会丢 WAL 内容）。
// 每日 03:47 自动备份（避开使用高峰与周一 00:00 结算）；升级前手动快照见 scripts/backup_db.cjs。
// 备份目录默认 backend/models/data/backups（*.db 被 gitignore，不会进仓），DLG_BACKUP_DIR 可覆盖。
const backupDir = process.env.DLG_BACKUP_DIR || path.join(__dirname, 'models', 'data', 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

async function backupDatabase() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const dest = path.join(backupDir, `app-${stamp}.db`);
  if (fs.existsSync(dest)) return; // 当日已有备份（幂等，不覆盖）
  await db.backup(dest);
  console.log(`[backup] 每日备份完成 → ${dest}`);
}
cron.schedule('47 3 * * *', () => {
  backupDatabase().catch((e) => console.error('[backup] 失败:', e));
}, { timezone: 'Asia/Shanghai' });
console.log(`[backup] 每日备份已调度 (03:47 Asia/Shanghai → ${backupDir})`);

// SPA fallback: any non-API GET goes to index.html so client-side routes
// (/course/..., /profile) survive a hard refresh. API 404s still fall through
// to Express's default handler. Missing ASSET files (old hash JS/CSS) get a real
// 404, never a 200 text/html — that white-screen trap is what stale-cache
// clients hit when dist is rebuilt.
if (hasDist) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const ext = path.extname(req.path);
    if (ext && ext !== '.html') return res.status(404).end('Not Found');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// JSON API 404 (D3): unmatched /api/* routes used to return Express's default
// HTML "<pre>Cannot GET ...</pre>" body.
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// JSON error handler (D3): Express's default handler returns HTML and — in dev
// mode — full stack traces with absolute paths, which the frontend collapses to
// a generic 'Network error'. Return JSON with no internals; log the detail here.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.status || err.code || '', err.message);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status >= 500 ? '服务器内部错误' : '请求格式不正确' });
});

// Routes are registered and the request pipeline is fully assembled before we
// bind. listen() error (e.g. port taken by a non-DLG process) → exit 1 so the
// guard/process manager restarts us; the DB is already initialized by then, but
// only this instance holds it — the port mutex above prevented a second opener.
const server = app.listen(PORT, HOST, () => {
  console.log(`🎓 DLG Learning Server running on http://${HOST}:${PORT}`);
});
server.on('error', (err) => {
  console.error('[fatal] listen 失败:', err);
  process.exit(1);
});
}

main();
