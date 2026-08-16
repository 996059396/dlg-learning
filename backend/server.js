// ABI preflight (P0-2): better-sqlite3 v13 is prebuilt for Node ABI 137. On
// Node 20 (ABI 115) the require itself segfaults with no readable message, and
// this server runs under nohup/guard where a bare crash is invisible. Fail fast
// with guidance BEFORE any module that touches better-sqlite3 is loaded.
if (Number(process.versions.modules) !== 137) {
  console.error(`[fatal] Node ABI = ${process.versions.modules} (需要 137) — better-sqlite3 v13 预编译二进制不匹配，require 即段错误。`);
  console.error('[fatal] 请改用 Node 24（ABI 137）启动 server.js，例如用本机 node24 二进制或 nvm 切到 Node 24。');
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

// ── Security headers (X07) ───────────────────────────────────────────────────
// Applied to every response (API + static). CSP is tuned for the Vite
// production build: script-src 'self' (bundled modules only — no inline
// scripts, no eval; SW registration lives in main.jsx for exactly this
// reason), style-src 'unsafe-inline' (React inline style attributes are
// pervasive in the SPA), img-src data: for the data-URI favicon. The SPA is
// never embedded (frame-ancestors none + DENY); Permissions-Policy blocks
// every device permission the app doesn't use.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

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
  // sw.js must NOT be cached long-term (crosscheck5 X M1): browsers fetch the
  // SW periodically to pick up updates; a 1y immutable header would freeze the
  // old service worker in place for a year. Serve it no-cache, before static.
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/javascript');
    res.sendFile(path.join(frontendDist, 'sw.js'));
  });
  app.use(express.static(frontendDist, { maxAge: '1y', immutable: true, index: false }));
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  // PWA (X02): explicit content-type for the manifest so install/audit tools see
  // application/manifest+json even on older express/send mime lookups. sw.js is
  // served by express.static above (its .js mime is always correct).
  app.get('/manifest.webmanifest', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json');
    res.sendFile(path.join(frontendDist, 'manifest.webmanifest'));
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
app.use('/api/metrics', require('./routes/metrics'));

// Health check
app.get('/api/health', (req, res) => {
  // lastBackupAt 供探活/监控检查「备份新鲜度」（crosscheck6 P high：03:47 漏跑曾静默 2 天）
  res.json({ status: 'ok', timestamp: new Date().toISOString(), lastBackupAt });
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

let lastBackupAt = null;
async function backupDatabase() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const dest = path.join(backupDir, `app-${stamp}.db`);
  if (fs.existsSync(dest)) { lastBackupAt = fs.statSync(dest).mtime.toISOString(); return; } // 当日已有（幂等）
  await db.backup(dest);
  lastBackupAt = new Date().toISOString();
  console.log(`[backup] 每日备份完成 → ${dest}`);
}
cron.schedule('47 3 * * *', () => {
  backupDatabase().catch((e) => console.error('[backup] 失败:', e));
}, { timezone: 'Asia/Shanghai' });
console.log(`[backup] 每日备份已调度 (03:47 Asia/Shanghai → ${backupDir})`);
// 启动补跑（crosscheck6 P high）：03:47 若机器睡眠/停机，node-cron 会静默跳过——
// 自 5011bb9 上线 2 天零产出。启动时若当日备份缺失则立即补一次。
backupDatabase().then((d) => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (lastBackupAt && lastBackupAt.slice(0, 10) === new Date().toISOString().slice(0, 10)) {
    console.log('[backup] 启动补跑完成（当日备份已就绪）');
  }
}).catch((e) => console.error('[backup] 启动补跑失败:', e.message));

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
