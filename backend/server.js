const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const compression = require('compression');
const { initializeDatabase, settleWeek, catchUpSettlements, getWeekStart } = require('./models/database');

const app = express();
const PORT = process.env.PORT || 3001;
// Bind address: default 0.0.0.0 (LAN/mobile testing on the same network).
// Override with HOST=127.0.0.1 to restrict to loopback only.
const HOST = process.env.HOST || '0.0.0.0';

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
  app.use(express.static(frontendDist, { maxAge: '1h', etag: true }));
  console.log('[static] Serving frontend from', frontendDist);
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

// SPA fallback: any non-API GET goes to index.html so client-side routes
// (/course/..., /profile) survive a hard refresh. API 404s still fall through
// to Express's default handler.
if (hasDist) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`🎓 DLG Learning Server running on http://${HOST}:${PORT}`);
});
