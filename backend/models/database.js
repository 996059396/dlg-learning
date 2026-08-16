const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// DLG_DB_PATH overrides the DB file (used by tests for an isolated throwaway DB).
const DB_PATH = process.env.DLG_DB_PATH || path.join(__dirname, 'data', 'app.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initializeDatabase() {
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT,
      avatar TEXT DEFAULT 'default',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Auth sessions: opaque bearer token -> user. Hash stored, never raw.
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    -- crosscheck6 B medium：logout-all / createSession 上限清理按 user_id 查，需索引
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- Game state per user
    CREATE TABLE IF NOT EXISTS game_state (
      user_id TEXT PRIMARY KEY,
      hearts INTEGER DEFAULT 5,
      max_hearts INTEGER DEFAULT 5,
      coins INTEGER DEFAULT 500,
      xp INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      last_streak_date TEXT,
      league TEXT DEFAULT 'bronze',
      league_rank INTEGER DEFAULT 0,
      xp_boost_multiplier REAL DEFAULT 1.0,
      xp_boost_until TEXT,
      freeze_item_count INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Course progress
    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      completed BOOLEAN DEFAULT 0,
      score INTEGER DEFAULT 0,
      max_score INTEGER DEFAULT 0,
      accuracy REAL DEFAULT 0,
      completed_at DATETIME,
      attempts INTEGER DEFAULT 0,
      UNIQUE(user_id, lesson_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Mistake log for "medical kit" review system
    CREATE TABLE IF NOT EXISTS mistakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      node_index INTEGER NOT NULL,
      node_id TEXT,
      question_text TEXT,
      user_answer TEXT,
      correct_answer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed BOOLEAN DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Practice-heal credit: coins/hearts for mistake review are earned by actually
    -- reviewing a card correctly through /mistakes/review. One unclaimed unit per
    -- DISTINCT mistake id, claimed atomically by /practice-heal. A crafted client
    -- can't mint coins by lying about correctCount (it must first send correct
    -- reviews, and the same card can never credit twice).
    CREATE TABLE IF NOT EXISTS review_credit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      mistake_id INTEGER NOT NULL,
      claimed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, mistake_id)
    );

    -- Append-only review history (B58 A2): one row per review attempt — the
    -- data base for retention/forgetting-curve stats and future FSRS parameter
    -- fitting (Anki revlog's minimal set). The mistakes table keeps the CURRENT
    -- SM-2 state; review_log records every transition so history is never lost
    -- (before it existed, a card's past schedule was un-auditable).
    CREATE TABLE IF NOT EXISTS review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      mistake_id INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL,
      quality INTEGER NOT NULL,
      correct INTEGER NOT NULL,
      response_time_ms INTEGER,
      interval_before INTEGER,
      interval_after INTEGER,
      ease_before REAL,
      ease_after REAL,
      session_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_review_log_user_time ON review_log(user_id, reviewed_at);

    -- Shop items owned
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, item_id)
    );

    -- Weekly leaderboard
    CREATE TABLE IF NOT EXISTS leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      xp_earned INTEGER DEFAULT 0,
      league TEXT DEFAULT 'bronze',
      final_rank INTEGER,
      tier_change TEXT,
      reward_claimed INTEGER DEFAULT 0,
      settled_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, week_start)
    );

    CREATE INDEX IF NOT EXISTS idx_lb_week_league_xp ON leaderboard(week_start, league, xp_earned DESC);
    CREATE INDEX IF NOT EXISTS idx_lb_user_week ON leaderboard(user_id, week_start);

    -- League history (per-user weekly snapshot for "past 12 weeks" view)
    CREATE TABLE IF NOT EXISTS league_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      league_from TEXT,
      league_to TEXT,
      final_rank INTEGER,
      xp_earned INTEGER,
      result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, week_start)
    );

    -- Per-node attempt telemetry (P0 D): one row per graded node per lesson
    -- completion, written INSIDE the grading transaction. Previously correct
    -- answers were discarded outright, so per-question p-values (error rates)
    -- were impossible to compute for content calibration. node_id + lesson_id
    -- let us aggregate difficulty per question; question_text snapshot makes
    -- analysis independent of later course edits.
    CREATE TABLE IF NOT EXISTS node_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      question_text TEXT,
      correct INTEGER NOT NULL,
      user_answer TEXT,
      lesson_accuracy INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_results_lesson_node ON node_results(lesson_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_node_results_node ON node_results(node_id);

    -- X02: idempotency receipts for OFFLINE lesson completion sync. The offline
    -- queue re-sends raw answers with a client_request_id after reconnect; a
    -- replayed request must return the ORIGINAL response instead of re-grading,
    -- or a retry after a lost response would double-mint rewards. The receipt is
    -- written in the SAME transaction as the rewards (see routes/courses.js).
    CREATE TABLE IF NOT EXISTS submission_receipts (
      user_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, client_request_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Defensive migration: add columns if upgrading an existing DB
  const lbCols = db.prepare("PRAGMA table_info(leaderboard)").all().map(c => c.name);
  ['final_rank','tier_change','reward_claimed','settled_at'].forEach(col => {
    if (!lbCols.includes(col)) {
      try {
        if (col === 'reward_claimed') db.exec(`ALTER TABLE leaderboard ADD COLUMN ${col} INTEGER DEFAULT 0`);
        else if (col === 'final_rank') db.exec(`ALTER TABLE leaderboard ADD COLUMN ${col} INTEGER`);
        else db.exec(`ALTER TABLE leaderboard ADD COLUMN ${col} TEXT`);
      } catch(e) { /* ignore if dup */ }
    }
  });

  // Defensive migration: users.password_hash (for existing DBs created before auth)
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('password_hash')) {
    try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch(e) { /* ignore */ }
  }

  // Enforce username uniqueness. Fails defensively on legacy DBs that already
  // contain duplicates (test/ghost rows); the register route does an app-level
  // pre-check regardless, so new duplicates are prevented everywhere.
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'); }
  catch(e) { console.warn('[db] users.username UNIQUE index skipped:', e.message); }

  // Defensive migration: mistakes.node_id (stable node.id addressing, replaces
  // position-based node_index for the grading contract).
  const mistakeCols = db.prepare("PRAGMA table_info(mistakes)").all().map(c => c.name);
  if (!mistakeCols.includes('node_id')) {
    try { db.exec('ALTER TABLE mistakes ADD COLUMN node_id TEXT'); } catch(e) { /* ignore */ }
  }

  // Defensive migration: game_state.streak_shield_count
  const gsCols = db.prepare("PRAGMA table_info(game_state)").all().map(c => c.name);
  if (!gsCols.includes('streak_shield_count')) {
    try { db.exec('ALTER TABLE game_state ADD COLUMN streak_shield_count INTEGER DEFAULT 0'); } catch(e) { /* ignore */ }
  }

  // Defensive migration: game_state.daily_xp + daily_xp_date — running daily cap
  // on lesson-completion XP (anti-farm; reset on Shanghai-day rollover).
  if (!gsCols.includes('daily_xp')) {
    try { db.exec('ALTER TABLE game_state ADD COLUMN daily_xp INTEGER DEFAULT 0'); } catch(e) { /* ignore */ }
  }
  if (!gsCols.includes('daily_xp_date')) {
    try { db.exec('ALTER TABLE game_state ADD COLUMN daily_xp_date TEXT'); } catch(e) { /* ignore */ }
  }
  // Defensive migration: game_state.last_heart_restore — cooldown for
  // /game/restore-heart (was free unlimited hearts; see routes/game.js).
  if (!gsCols.includes('last_heart_restore')) {
    try { db.exec('ALTER TABLE game_state ADD COLUMN last_heart_restore TEXT'); } catch(e) { /* ignore */ }
  }

  // Defensive migration: mistakes SM-2 spaced-repetition columns
  const mkCols = db.prepare("PRAGMA table_info(mistakes)").all().map(c => c.name);
  const mkMigrations = {
    easiness: 'ALTER TABLE mistakes ADD COLUMN easiness REAL DEFAULT 2.5',
    interval_days: 'ALTER TABLE mistakes ADD COLUMN interval_days INTEGER DEFAULT 0',
    review_count: 'ALTER TABLE mistakes ADD COLUMN review_count INTEGER DEFAULT 0',
    next_review_date: 'ALTER TABLE mistakes ADD COLUMN next_review_date TEXT',
    mastered: 'ALTER TABLE mistakes ADD COLUMN mastered BOOLEAN DEFAULT 0',
    // crosscheck6 C high：lapses 连续失败计数 / leech 达到阈值标记（Anki 式，
    // 二元判分使 easiness 恒 2.5 是死字段——用 lapses 补「慢性错误卡」识别维度）
    lapses: 'ALTER TABLE mistakes ADD COLUMN lapses INTEGER DEFAULT 0',
    leech: 'ALTER TABLE mistakes ADD COLUMN leech BOOLEAN DEFAULT 0',
    // C10: 多选池错题卡选项 id 会话级重映射。池文件选项 id 恒 {A,B,C,D} 且正确项
    // 固定——错题卡若不重映射，脚本盲猜 ["A","B"] 即 100% 判对铸币。入册时生成
    // {原始id: 随机ms-xxxx} 存此列，review/卡面都用重映射后的 id 判分。
    remap_json: 'ALTER TABLE mistakes ADD COLUMN remap_json TEXT',
  };
  for (const [col, sql] of Object.entries(mkMigrations)) {
    if (!mkCols.includes(col)) {
      try { db.exec(sql); } catch(e) { /* ignore */ }
    }
  }
  // Backfill: pre-SM2 mistakes are immediately due (Asia/Shanghai date).
  try { db.exec(`UPDATE mistakes SET next_review_date = '${todayShanghai()}' WHERE next_review_date IS NULL`); } catch(e) {}

  // Mistake-list perf (60-agent 性能审查): getUnreviewedMistakes /
  // getDueMistakeCount filter by (user_id, mastered, next_review_date) and
  // addMistake's existence check by (user_id, lesson_id, node_id). Without
  // these every query was a full-table scan that ALSO stretched the grading
  // write transaction (addMistake runs inside /lessons/:id/complete and
  // /exam/submit), serializing concurrent submissions. Measured on a 120k-row
  // twin: dueCount 4.3ms→0.023ms, unreviewed list 7.4ms→0.26ms. MUST come after
  // the mastered/next_review_date migrations above (they are not in the base
  // CREATE TABLE).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mistakes_user_due ON mistakes(user_id, mastered, next_review_date);
    CREATE INDEX IF NOT EXISTS idx_mistakes_user_node ON mistakes(user_id, lesson_id, node_id);
  `);

  // CRITICAL: SQLite's CREATE TABLE IF NOT EXISTS won't add UNIQUE constraints
  // to a pre-existing table. Rebuild inventory if it lacks UNIQUE(user_id, item_id).
  const invSchemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'").get();
  const invHasUnique = invSchemaRow && /UNIQUE\s*\(\s*user_id\s*,\s*item_id\s*\)/i.test(invSchemaRow.sql);
  if (invSchemaRow && !invHasUnique) {
    console.log('[migration] inventory missing UNIQUE(user_id, item_id) — rebuilding table...');
    db.exec(`
      CREATE TABLE inventory_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        quantity INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, item_id)
      );
      INSERT OR IGNORE INTO inventory_new (user_id, item_id, quantity)
        SELECT user_id, item_id, SUM(quantity) FROM inventory GROUP BY user_id, item_id;
      DROP TABLE inventory;
      ALTER TABLE inventory_new RENAME TO inventory;
    `);
    console.log('[migration] inventory rebuilt with UNIQUE constraint.');
  }

  // CRITICAL: SQLite's CREATE TABLE IF NOT EXISTS won't add UNIQUE constraints
  // to a pre-existing table. Check if the unique constraint exists; if not, rebuild.
  const lbSchemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leaderboard'").get();
  const hasUnique = lbSchemaRow && /UNIQUE\s*\(\s*user_id\s*,\s*week_start\s*\)/i.test(lbSchemaRow.sql);
  if (!hasUnique) {
    console.log('[migration] leaderboard missing UNIQUE(user_id, week_start) — rebuilding table...');
    // Rebuild: copy data into new table, drop old, rename
    db.exec(`
      CREATE TABLE leaderboard_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        week_start TEXT NOT NULL,
        xp_earned INTEGER DEFAULT 0,
        league TEXT DEFAULT 'bronze',
        final_rank INTEGER,
        tier_change TEXT,
        reward_claimed INTEGER DEFAULT 0,
        settled_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, week_start)
      );
      INSERT OR IGNORE INTO leaderboard_new
        (id, user_id, week_start, xp_earned, league, final_rank, tier_change, reward_claimed, settled_at)
      SELECT
        id, user_id, week_start, xp_earned,
        COALESCE(league, 'bronze'),
        final_rank, tier_change, COALESCE(reward_claimed, 0), settled_at
      FROM leaderboard;
      DROP TABLE leaderboard;
      ALTER TABLE leaderboard_new RENAME TO leaderboard;
      CREATE INDEX IF NOT EXISTS idx_lb_week_league_xp ON leaderboard(week_start, league, xp_earned DESC);
      CREATE INDEX IF NOT EXISTS idx_lb_user_week ON leaderboard(user_id, week_start);
    `);
    console.log('[migration] leaderboard rebuilt with UNIQUE constraint.');
  }

  // Create default demo user if not exists
  const existingUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!existingUser) {
    const userId = uuidv4();
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(userId, '小电工');
    db.prepare('INSERT INTO game_state (user_id) VALUES (?)').run(userId);
    console.log('Created demo user: 小电工');
  }

  console.log('Database initialized successfully');
}

// ── User & Game State Queries ──

function getUser(userId) {
  // Explicit column list — NEVER u.*: users.password_hash must not leave the DB.
  // g.* is safe (game_state holds no secrets) and stays robust to future columns.
  return db.prepare(`
    SELECT u.id, u.username, u.avatar, u.created_at, u.last_login, g.*
    FROM users u
    LEFT JOIN game_state g ON u.id = g.user_id
    WHERE u.id = ?
  `).get(userId);
}

function getGameState(userId) {
  return db.prepare('SELECT * FROM game_state WHERE user_id = ?').get(userId);
}

function getInventory(userId) {
  return db.prepare('SELECT item_id, quantity FROM inventory WHERE user_id = ? ORDER BY item_id').all(userId);
}

function updateGameState(userId, updates) {
  const fields = Object.keys(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);
  db.prepare(`UPDATE game_state SET ${setClause} WHERE user_id = ?`).run(...values, userId);
  return getGameState(userId);
}

function addXP(userId, amount) {
  const state = getGameState(userId);
  const multiplier = state.xp_boost_until && new Date(state.xp_boost_until) > new Date()
    ? state.xp_boost_multiplier
    : 1.0;
  const earned = Math.round(amount * multiplier);
  db.prepare('UPDATE game_state SET xp = xp + ? WHERE user_id = ?').run(earned, userId);

  // Update weekly leaderboard
  const weekStart = getWeekStart();
  // Atomic upsert: respects UNIQUE(user_id, week_start), also keeps league synced to current
  db.prepare(`
    INSERT INTO leaderboard (user_id, week_start, xp_earned, league)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, week_start) DO UPDATE SET
      xp_earned = xp_earned + excluded.xp_earned,
      league = excluded.league
  `).run(userId, weekStart, earned, state.league);
  return earned;
}

// Daily cap on lesson-completion XP (anti-farm). Farming the same lesson
// repeatedly used to mint +2 XP with no ceiling; now a user's lesson XP is
// bounded per Shanghai-day and the excess is clamped to 0 (the ledger is not
// over-drawn). Returns the ACTUAL XP granted after capping (pre-multiplier).
const DAILY_XP_CAP = 150;
function addLessonXP(userId, amount) {
  const state = getGameState(userId);
  const today = todayShanghai();
  if (state.daily_xp_date !== today) {
    // New Shanghai day: reset the running tally.
    db.prepare('UPDATE game_state SET daily_xp = 0, daily_xp_date = ? WHERE user_id = ?').run(today, userId);
  }
  const used = state.daily_xp_date === today ? (state.daily_xp || 0) : 0;
  const allowed = Math.max(0, DAILY_XP_CAP - used);
  const capped = Math.min(amount, allowed);
  if (capped <= 0) return 0;
  db.prepare('UPDATE game_state SET daily_xp = daily_xp + ? WHERE user_id = ?').run(capped, userId);
  return addXP(userId, capped);
}

// ── Auth: sessions & passwords ──
// Session tokens are opaque random strings; only their SHA-256 hash is stored.
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const MAX_SESSIONS_PER_USER = 20; // 每用户会话上限（防僵尸 token 撑爆 sessions 表）
// Absolute lifetime cap: sliding renewal extends a session to at most 90 days
// from creation, so an account that goes dark eventually (and safely) expires.
const SESSION_MAX_MS = 90 * 24 * 3600 * 1000;

function _hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  // 认证加固（crosscheck6 B medium）：清理过期会话 + 每用户会话上限
  //（防 sessions 表被僵尸 token 撑爆，同时保住滑动续期语义）。
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(userId, now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(_hashToken(token), userId, now, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  // 插入后收紧到上限（保最新 MAX 条），确保 ≤ MAX。
  const cnt = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(userId).c;
  if (cnt > MAX_SESSIONS_PER_USER) {
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (
      SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`)
      .run(userId, userId, MAX_SESSIONS_PER_USER);
  }
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const hash = _hashToken(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!s) return null;
  const now = Date.now();
  if (new Date(s.expires_at).getTime() < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  // Sliding renewal: an active user's session keeps extending (capped at
  // SESSION_MAX_MS from creation), so a learner returning after >30 days is not
  // silently logged out with their progress stranded. Legacy sessions without
  // created_at are assumed to have started at expires_at − TTL. Only writes when
  // the renewal is meaningful (≥1h advance) to keep per-request writes bounded.
  const created = s.created_at
    ? new Date(s.created_at).getTime()
    : new Date(s.expires_at).getTime() - SESSION_TTL_MS;
  const desired = Math.min(now + SESSION_TTL_MS, created + SESSION_MAX_MS);
  const current = new Date(s.expires_at).getTime();
  if (desired - current > 60 * 60 * 1000) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(new Date(desired).toISOString(), hash);
  }
  return getUser(s.user_id);
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(_hashToken(token));
}

// Revoke EVERY session for a user (60-agent 安全审查 "会话无撤销"): used by
// logout-all and by change-password (a rotated password must kill the old
// tokens still floating in localStorage on other devices).
function deleteAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Change password: verifies the CURRENT password, then sets the new one and
// revokes all sessions so stolen/old tokens die with the old secret.
function changePassword(userId, oldPassword, newPassword) {
  if (!verifyPassword(userId, oldPassword)) return false;
  if (typeof newPassword !== 'string' || newPassword.length < 6) return false;
  setUserPassword(userId, newPassword);
  deleteAllSessions(userId);
  return true;
}

function _hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function setUserPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(`${salt}:${_hashPassword(password, salt)}`, userId);
}

function verifyPassword(userId, password) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !user.password_hash) return false;
  const [salt, hash] = String(user.password_hash).split(':');
  if (!salt || !hash) return false;
  return _hashPassword(password, salt) === hash;
}

// ── Time helpers (fixed to Asia/Shanghai = UTC+8) ──
// Returns the Monday 00:00 (Asia/Shanghai) of the week containing `whenMs` as YYYY-MM-DD.
function getWeekStart(whenMs) {
  const ms = whenMs ?? Date.now();
  // Shift to Shanghai time by adding 8h, then read UTC fields to avoid server TZ issues.
  const shifted = new Date(ms + 8 * 3600 * 1000);
  const dayUTC = shifted.getUTCDay();              // 0=Sun..6=Sat (in Shanghai-perspective)
  const diff = (dayUTC === 0 ? -6 : 1 - dayUTC);   // days to most-recent Monday
  const monday = new Date(shifted.getTime() + diff * 86400 * 1000);
  // Format YYYY-MM-DD (Shanghai-perspective)
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(monday.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// YYYY-MM-DD of "now" in Asia/Shanghai. The rest of the app used UTC
// (toISOString().split('T')[0]) for streaks/SM-2 while weeks already used
// Shanghai — so between 00:00–08:00 Shanghai time the day rolled over to the
// PREVIOUS date and a check-in at Shanghai midnight broke the streak. All
// "today"/"yesterday" logic must go through these two helpers, never UTC.
function todayShanghai() {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// YYYY-MM-DD `days` days before "now" in Asia/Shanghai (daysAgoShanghai(1) = yesterday).
function daysAgoShanghai(days) {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000 - days * 86400 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Returns the next Monday 00:00 Asia/Shanghai as a UTC ISO string (when this week ends).
function getWeekEndsAt(whenMs) {
  const ms = whenMs ?? Date.now();
  const startStr = getWeekStart(ms);
  // Parse YYYY-MM-DD as Shanghai-midnight (which is UTC of previous day 16:00).
  const [y, m, d] = startStr.split('-').map(Number);
  // Shanghai midnight = UTC (y-m-d) 00:00 minus 8h = previous-day 16:00
  // Construct as: UTC midnight of that date, then minus 8h offset
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0) - 8 * 3600 * 1000;
  // Add 7 days to reach next Monday Shanghai midnight (UTC)
  return new Date(utcMidnight + 7 * 86400 * 1000).toISOString();
}

// ── Progress Queries ──

function getProgress(userId) {
  return db.prepare('SELECT * FROM progress WHERE user_id = ?').all(userId);
}

function saveProgress(userId, lessonId, data) {
  const existing = db.prepare(
    'SELECT id FROM progress WHERE user_id = ? AND lesson_id = ?'
  ).get(userId, lessonId);

  if (existing) {
    db.prepare(`
      UPDATE progress SET completed = ?, score = ?, max_score = ?,
        accuracy = ?, completed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
      WHERE user_id = ? AND lesson_id = ?
    `).run(data.completed ? 1 : 0, data.score, data.maxScore, data.accuracy, userId, lessonId);
  } else {
    db.prepare(`
      INSERT INTO progress (user_id, lesson_id, completed, score, max_score, accuracy, attempts, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(userId, lessonId, data.completed ? 1 : 0, data.score, data.maxScore, data.accuracy);
  }
  return db.prepare('SELECT * FROM progress WHERE user_id = ? AND lesson_id = ?').get(userId, lessonId);
}

// ── Mistakes Queries (SM-2 spaced repetition) ──

const SM2_MASTERED_INTERVAL = 21; // interval_days >= 21 ⇒ mastered
const LEECH_THRESHOLD = 8; // 连续判错达 8 次标记 leech（Anki 式慢性错误卡识别）

// Add (or refresh) a mistake card for (user, lesson, node). Getting the same
// node wrong again in a later attempt refreshes the card instead of duplicating.
// node_id is the stable addressing key (node.id, globally unique); node_index is
// kept for legacy rows created before node_id existed.
function addMistake(userId, lessonId, nodeId, nodeIndex, questionText, userAnswer, correctAnswer, remapJson = null) {
  const today = todayShanghai();
  const existing = nodeId
    ? db.prepare(
        'SELECT id FROM mistakes WHERE user_id = ? AND lesson_id = ? AND node_id = ?'
      ).get(userId, lessonId, nodeId)
    : db.prepare(
        'SELECT id FROM mistakes WHERE user_id = ? AND lesson_id = ? AND node_index = ?'
      ).get(userId, lessonId, nodeIndex);

  if (existing) {
    db.prepare(`
      UPDATE mistakes SET
        question_text = ?, user_answer = ?, correct_answer = ?, remap_json = ?,
        reviewed = 0, mastered = 0, easiness = 2.5, interval_days = 0,
        review_count = 0, next_review_date = ?, created_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(questionText, userAnswer, correctAnswer, remapJson, today, existing.id);
  } else {
    db.prepare(`
      INSERT INTO mistakes
        (user_id, lesson_id, node_id, node_index, question_text, user_answer, correct_answer,
         remap_json, next_review_date, easiness, interval_days, review_count, mastered)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, 0)
    `).run(userId, lessonId, nodeId, nodeIndex, questionText, userAnswer, correctAnswer, remapJson, today);
  }
}

// P0 D telemetry: record one graded node attempt per row. Called inside the
// lesson-completion transaction so correct-answer data is never lost (it was
// previously discarded outright — the audit's "p-value impossible" finding).
function addNodeResult(userId, lessonId, node, isCorrect, userAnswer, lessonAccuracy) {
  db.prepare(`
    INSERT INTO node_results (user_id, lesson_id, node_id, node_type, question_text, correct, user_answer, lesson_accuracy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, lessonId,
    node.id, node.type,
    node.question || node.title || '',
    isCorrect ? 1 : 0,
    String(userAnswer ?? ''),
    lessonAccuracy,
    todayShanghai()
  );
}

// Aggregate difficulty per node (p-value = P(correct)) for content calibration.
function getNodeStats(lessonId) {
  return db.prepare(`
    SELECT node_id, node_type, COUNT(*) attempts,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) AS pct_correct
    FROM node_results WHERE lesson_id = ?
    GROUP BY node_id, node_type
    ORDER BY pct_correct ASC
  `).all(lessonId);
}

// 全库最难题（crosscheck6 F 方向：metrics 端点接线——getNodeStats 曾零路由调用）。
// p-value = 正确率（难度代理），跨用户聚合，供内容校准/冲刺卷组卷。
function getHardestNodes(limit = 20) {
  return db.prepare(`
    SELECT node_id, lesson_id, node_type, COUNT(*) attempts,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) AS pct_correct
    FROM node_results GROUP BY node_id, lesson_id, node_type
    HAVING COUNT(*) >= 3            -- 至少 3 次作答才可信，过滤冷启动噪声
    ORDER BY pct_correct ASC LIMIT ?
  `).all(limit);
}

// 当前用户自己的 node_results 聚合（正确率/题数/错题数），供「我的分析」。
function getUserNodeStats(userId) {
  return db.prepare(`
    SELECT COUNT(*) attempts,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) AS pct_correct,
           SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS mistakes,
           COUNT(DISTINCT lesson_id) AS lessons_touched
    FROM node_results WHERE user_id = ?
  `).get(userId);
}

// 当前用户按课聚合的薄弱排行（正确率升序前 N）。
function getUserLessonsStats(userId, limit = 10) {
  return db.prepare(`
    SELECT lesson_id, COUNT(*) attempts,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) AS pct_correct
    FROM node_results WHERE user_id = ? GROUP BY lesson_id
    ORDER BY pct_correct ASC LIMIT ?
  `).all(userId, limit);
}

// Due mistakes: not mastered AND next_review_date <= today.
// B58 A6/F3 queue tiering + priority: the combined queue is DUE REVIEWS
// (review_count > 0, most-overdue first — "到期最久优先" per A6) followed by NEW
// learning-step cards (review_count = 0, today's mistakes). Each tier has its
// own per-fetch cap (QUEUE_REVIEW_CAP / QUEUE_NEW_CAP) so neither floods a
// fetch, and offset pages correctly over the combined queue (a backlog of
// overdue reviews can't strand fresh mistakes, nor vice versa).
const QUEUE_REVIEW_CAP = 50; // 复习步硬顶
const QUEUE_NEW_CAP = 20;    // 学习步硬顶
function getUnreviewedMistakes(userId, limit = 10, offset = 0) {
  const today = todayShanghai();
  const reviewsCount = db.prepare(`
    SELECT COUNT(*) c FROM mistakes
    WHERE user_id = ? AND mastered = 0 AND review_count > 0 AND next_review_date <= ?
  `).get(userId, today).c;
  const reviewOffset = Math.min(offset, reviewsCount);
  const reviewTake = Math.min(limit, reviewsCount - reviewOffset, QUEUE_REVIEW_CAP);
  const reviews = reviewTake > 0 ? db.prepare(`
    SELECT * FROM mistakes
    WHERE user_id = ? AND mastered = 0 AND review_count > 0 AND next_review_date <= ?
    ORDER BY next_review_date ASC, created_at ASC
    LIMIT ? OFFSET ?
  `).all(userId, today, reviewTake, reviewOffset) : [];
  const newOffset = Math.max(0, offset - reviewsCount);
  const newTake = Math.min(limit - reviewTake, QUEUE_NEW_CAP);
  const news = newTake > 0 ? db.prepare(`
    SELECT * FROM mistakes
    WHERE user_id = ? AND mastered = 0 AND review_count = 0 AND next_review_date <= ?
    ORDER BY next_review_date ASC, created_at ASC
    LIMIT ? OFFSET ?
  `).all(userId, today, newTake, newOffset) : [];
  return [...reviews, ...news];
}

function getDueMistakeCount(userId) {
  const today = todayShanghai();
  const row = db.prepare(`
    SELECT COUNT(*) c FROM mistakes
    WHERE user_id = ? AND mastered = 0 AND next_review_date <= ?
  `).get(userId, today);
  return row?.c || 0;
}

// SM-2 core: advance (easiness, interval, repetition) for a recall quality q (0-5).
// Returns { easiness, interval, repetition }.
function _sm2(curEasiness, curInterval, curRepetition, q) {
  const EF = curEasiness;
  const interval = curInterval || 0;
  const repetition = curRepetition || 0;

  if (q < 3) {
    // SM-2 canonical step 6: a failed recall restarts the interval ladder
    // WITHOUT touching EF — the old code applied the EF formula on failures
    // too, so a hard card's EF ratcheted toward the 1.3 floor and it took ~7
    // correct recalls to master instead of ~4 (B58 A1). Failure resets the
    // ladder; only success feeds the growth curve.
    return { easiness: EF, interval: 1, repetition: 0 };
  }
  let r = repetition + 1;
  let iv = 1;
  if (r === 1) iv = 1;
  else if (r === 2) iv = 6;
  else iv = Math.round(interval * EF);
  let ef = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ef < 1.3) ef = 1.3;
  return { easiness: ef, interval: iv, repetition: r };
}

function _addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + days * 86400000);
  return dt.toISOString().split('T')[0];
}

// Record a review outcome for a mistake (ownership-scoped).
// correct=true → SM-2 quality 4; wrong → quality 2.
// grantCredit controls whether practice-heal credit is issued: callers MUST
// pass false unless the answer was verified server-side (never trust a client
// boolean — see routes/game.js /mistakes/review).
// extra: { responseTimeMs, sessionId } → written to review_log (B58 A2 retention
// data base). The state UPDATE + review_log append + credit grant are atomic: a
// failure between them used to leave the schedule advanced without a log row.
// Returns the updated mistake row, or null if the mistake isn't found.
function reviewMistake(mistakeId, userId, correct, grantCredit = true, extra = {}) {
  const row = db.prepare('SELECT * FROM mistakes WHERE id = ? AND user_id = ?').get(mistakeId, userId);
  if (!row) return null;

  const q = correct ? 4 : 2;
  const { easiness, interval, repetition } = _sm2(
    row.easiness ?? 2.5, row.interval_days ?? 0, row.review_count ?? 0, q
  );
  const nextReview = _addDays(todayShanghai(), interval);
  const mastered = correct && interval >= SM2_MASTERED_INTERVAL ? 1 : 0;
  const beforeEase = row.easiness ?? 2.5;
  const beforeInterval = row.interval_days ?? 0;
  // crosscheck6 C high：lapses 连续失败计数（判对清零，判错 +1，达阈值置 leech；
  // 判对同时清 leech——一次成功即解除挂起标识，Anki 语义）。
  const newLapses = correct ? 0 : (row.lapses || 0) + 1;
  const leechFlag = correct ? 0 : (newLapses >= LEECH_THRESHOLD ? 1 : (row.leech || 0));

  db.transaction(() => {
    db.prepare(`
      UPDATE mistakes SET
        easiness = ?, interval_days = ?, review_count = ?,
        next_review_date = ?, reviewed = ?, mastered = ?,
        lapses = ?, leech = ?
      WHERE id = ? AND user_id = ?
    `).run(easiness, interval, repetition, nextReview, correct ? 1 : 0, mastered,
      newLapses, leechFlag, mistakeId, userId);

    // B58 A2: append-only review history (forgetting-curve / retention stats,
    // future FSRS fitting). reviewed_at is a full ISO timestamp so retention can
    // be measured in time, not just days.
    db.prepare(`
      INSERT INTO review_log
        (user_id, mistake_id, reviewed_at, quality, correct,
         response_time_ms, interval_before, interval_after, ease_before, ease_after, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, mistakeId, new Date().toISOString(), q, correct ? 1 : 0,
      extra.responseTimeMs ?? null,
      beforeInterval, interval, beforeEase, easiness,
      extra.sessionId ?? null
    );

    // A correct recall earns one unit of practice-heal credit (deduped per
    // mistake) — only when the caller verified the answer server-side.
    if (correct && grantCredit) {
      db.prepare('INSERT OR IGNORE INTO review_credit (user_id, mistake_id) VALUES (?, ?)').run(userId, mistakeId);
    }
  })();

  return db.prepare('SELECT * FROM mistakes WHERE id = ?').get(mistakeId);
}

// Fetch a single mistake row by id, ownership-scoped. Returns null if absent.
function getMistake(mistakeId, userId) {
  return db.prepare('SELECT * FROM mistakes WHERE id = ? AND user_id = ?').get(mistakeId, userId) || null;
}

// ── Practice-heal credit ──

function getUnclaimedReviewCredit(userId) {
  const row = db.prepare('SELECT COUNT(*) c FROM review_credit WHERE user_id = ? AND claimed = 0').get(userId);
  return row?.c || 0;
}

// Claim unclaimed review credit for a user, up to `limit` units (default all).
// Excess beyond the limit stays unclaimed for a later practice-heal — the old
// "claim all, reward only 20" logic silently discarded surplus credit.
// Returns how many units were granted.
// ATOMIC (P26/P28): one UPDATE with a self-referencing subquery, so the
// SELECT-and-mark is no longer two statements a concurrent process can interleave
// (dual-server double-claim was real). The subquery reads claimed=0 rows BEFORE
// the outer UPDATE flips them, so a second concurrent caller sees 0 rows.
function claimReviewCredit(userId, limit = null) {
  const n = limit == null ? -1 : limit; // SQLite LIMIT -1 = no limit
  const info = db.prepare(`
    UPDATE review_credit SET claimed = 1
    WHERE user_id = ? AND claimed = 0
      AND id IN (
        SELECT id FROM review_credit
        WHERE user_id = ? AND claimed = 0
        ORDER BY id LIMIT ?
      )
  `).run(userId, userId, n);
  return info.changes;
}

// Force-dismiss an orphaned mistake card (its node no longer exists in course
// data, so it can never be re-graded). Marked mastered so it leaves the SM-2
// queue instead of rescheduling forever — the "永无法 mastered" dead-end.
// Returns true if the row belonged to this user and was updated.
function dismissMistake(mistakeId, userId) {
  const info = db.prepare(
    'UPDATE mistakes SET mastered = 1, reviewed = 1 WHERE id = ? AND user_id = ?'
  ).run(mistakeId, userId);
  return info.changes > 0;
}

// ── Leaderboard Queries ──

function getLeaderboard(league, limit = 10) {
  const weekStart = getWeekStart();
  return db.prepare(`
    SELECT u.username, u.avatar, lb.xp_earned, lb.user_id, lb.week_start, lb.league
    FROM leaderboard lb
    JOIN users u ON lb.user_id = u.id
    WHERE lb.week_start = ? AND lb.league = ?
    ORDER BY lb.xp_earned DESC
    LIMIT ?
  `).all(weekStart, league, limit);
}

// === Ghost generation ===
// Stable per (league, weekStart, ghostIndex). Animal-style emoji avatars,
// no 👻, so user can't tell apart from real players.
const GHOST_NAMES = ['电弧侠','钳工大师','欧姆定律','绝缘体','兆欧表',
  '地线君','继电器君','万用表妹','变压器哥','熔断器','接触器','避雷针','电容妹','电感哥',
  '老张师傅','小李学徒','王工','刘组长','赵班长','陈技师'];
const GHOST_AVATARS = ['🦊','🐼','🦁','🐯','🐻','🐺','🦉','🐰','🐸','🦝','🐨','🐱'];

// Tiny deterministic PRNG: xfnv1a + mulberry32 (no deps).
function _stringSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function _mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const LEAGUE_BASE_XP = {
  bronze: 30,
  silver: 80,
  gold: 160,
  emerald: 280,
  diamond: 450,
};

function generateGhostLeaderboard(league, _userXP_unused, count = 9, weekStart = null) {
  const ws = weekStart || getWeekStart();
  const base = LEAGUE_BASE_XP[league] ?? 30;
  const rand = _mulberry32(_stringSeed(`${league}|${ws}`));
  // Pick N distinct names deterministically
  const pool = [...GHOST_NAMES];
  const ghosts = [];
  for (let i = 0; i < count; i++) {
    const nameIdx = Math.floor(rand() * pool.length) % pool.length;
    const name = pool.splice(nameIdx, 1)[0] || GHOST_NAMES[i % GHOST_NAMES.length];
    const avatar = GHOST_AVATARS[Math.floor(rand() * GHOST_AVATARS.length)];
    // XP distribution: spread around base XP with deterministic noise
    const noise = Math.floor((rand() - 0.5) * base * 0.8);
    const xp = Math.max(0, base + noise + (count - i) * Math.floor(base * 0.15));
    ghosts.push({
      username: name,
      avatar,
      xp_earned: xp,
      user_id: `ghost_${league}_${ws}_${i}`,
      is_ghost: true,
    });
  }
  ghosts.sort((a, b) => b.xp_earned - a.xp_earned);
  return ghosts;
}

// === Settlement: promote/demote/archive at week boundary ===
const LEAGUE_ORDER = ['bronze', 'silver', 'gold', 'emerald', 'diamond'];
const LEAGUE_RULES = {
  bronze:  { promoteTop: 7, demoteBottom: 0 },  // no demotion (floor)
  silver:  { promoteTop: 5, demoteBottom: 5 },
  gold:    { promoteTop: 5, demoteBottom: 5 },
  emerald: { promoteTop: 3, demoteBottom: 5 },
  diamond: { promoteTop: 0, demoteBottom: 5 }, // ceiling, no promotion
};
const MIN_XP_TO_DEMOTE = 50; // Zero-XP protection

// Effective promotion/demotion zone sizes for a league of `total` players
// (crosscheck3 P26 P2). The static rules assume a FULL league; in a small league
// they overlap or swallow everyone — e.g. a 5-player silver league (5 top / 5
// bottom) promoted ALL 5 and could never demote, so the tiers inflated on every
// settlement. Scale both zones down proportionally so they never overlap and at
// least one middle rank stays put. Full leagues (promote+demote ≤ total-1) are
// unaffected — this only kicks in when the zones would collide. A solo player is
// the top of their league by definition, so they still promote (no dead-end at
// the floor) while never being demoted.
function effectiveZones(total, rules) {
  const rawPromote = rules?.promoteTop || 0;
  const rawDemote = rules?.demoteBottom || 0;
  if (total <= 1) {
    return { promote: rawPromote > 0 ? 1 : 0, demote: 0 };
  }
  const room = Math.max(0, total - 1); // at least one rank stays in the middle
  if (rawPromote + rawDemote <= room) {
    return { promote: rawPromote, demote: rawDemote };
  }
  const scale = room / (rawPromote + rawDemote);
  let promote = Math.floor(rawPromote * scale);
  let demote = Math.floor(rawDemote * scale);
  // total=2 floor semantics (crosscheck4 #9): with room=1 both zones floor to 0,
  // so the champion of a 2-player league never advances — a dead-end even at the
  // floor leagues. Guarantee at least the top spot promotes when the rules allow
  // promotion and there's room; demote then shrinks so promote+demote never
  // overlap (at least one middle rank still stays put).
  if (rawPromote > 0 && promote === 0) promote = 1;
  demote = Math.min(demote, Math.max(0, room - promote));
  return { promote, demote };
}

// Mutex guard: settlement is idempotent and can be triggered from cron, admin,
// and startup catch-up — never run two concurrently.
let settling = false;

// Settle a FINISHED week: assign final ranks, apply league tier changes, and
// write league history — all inside a single transaction so a mid-loop failure
// can't leave half the league promoted and the other half stuck.
function settleWeek(targetWeekStart = null, force = false) {  // Settle the FINISHED week (the one before "now"). If a date is given, settle that one.
  const ws = targetWeekStart || getWeekStart(Date.now() - 7 * 86400 * 1000);
  // NEVER settle the active/current week: the in-progress league is still being
  // played, and a premature settle permanently freezes its standings (C2 audit
  // finding: the 2026-08-10 week was force-settled mid-week). Only finished
  // weeks (strictly before today's week-start) may be settled.
  const currentWeek = getWeekStart();
  if (ws >= currentWeek) {
    console.warn(`[settleWeek] Refusing to settle active week ${ws} (current=${currentWeek}) — only finished weeks can be settled`);
    return { weekStart: ws, settled: [], skipped: true, reason: 'active-week' };
  }
  // crosscheck4 #9: force may ONLY re-settle the most recent finished week that
  // still has unsettled rows. Re-running an OLDER (already-settled) week
  // recomputes each user's tier from stale data and OVERWRITES their CURRENT
  // league in game_state — a user promoted to gold in a later week gets rolled
  // back to the tier this old week assigned. The latest unsettled week re-runs
  // deterministically over the same frozen rows, so force there is idempotent.
  if (force) {
    const latestUnsettled = db.prepare(`
      SELECT week_start FROM leaderboard
      WHERE settled_at IS NULL AND week_start < ?
      ORDER BY week_start DESC LIMIT 1
    `).get(currentWeek);
    if (!latestUnsettled || latestUnsettled.week_start !== ws) {
      console.warn(`[settleWeek] force 只允许重算最新未结算周（${latestUnsettled?.week_start ?? '无'}），拒绝 ${ws}`);
      return { weekStart: ws, settled: [], skipped: true, reason: 'force-not-latest-unsettled' };
    }
  }
  if (settling) {
    console.log(`[settleWeek] Already settling — skipping ${ws}`);
    return { weekStart: ws, settled: [], skipped: true };
  }
  settling = true;
  const settledRows = [];
  try {
    const tx = db.transaction(() => {
      for (const league of LEAGUE_ORDER) {
        const rules = LEAGUE_RULES[league];
        const filterSettled = force ? '' : 'AND (lb.settled_at IS NULL)';
        const rows = db.prepare(`
          SELECT lb.*, u.username FROM leaderboard lb
          JOIN users u ON lb.user_id = u.id
          WHERE lb.week_start = ? AND lb.league = ?
            ${filterSettled}
          ORDER BY lb.xp_earned DESC
        `).all(ws, league);
        if (!rows.length) continue;

        const total = rows.length;
        // Effective zones scaled to the ACTUAL league size (P26 P2): static
        // zone counts assume a full league; a 5-player league must not promote
        // all 5 and demote 0. Promotion and demotion never overlap, so at
        // least one middle rank always stays put.
        const { promote, demote } = effectiveZones(total, rules);
        rows.forEach((row, idx) => {
          const rank = idx + 1;
          let tierChange = 'stay';
          let nextLeague = league;
          const myIdx = LEAGUE_ORDER.indexOf(league);

          if (promote > 0 && rank <= promote && myIdx < LEAGUE_ORDER.length - 1) {
            tierChange = 'promoted';
            nextLeague = LEAGUE_ORDER[myIdx + 1];
          } else if (
            demote > 0 &&
            rank > total - demote &&
            myIdx > 0 &&
            row.xp_earned >= MIN_XP_TO_DEMOTE
          ) {
            tierChange = 'demoted';
            nextLeague = LEAGUE_ORDER[myIdx - 1];
          }

          // Update leaderboard row with final rank + change
          db.prepare(`
            UPDATE leaderboard
            SET final_rank = ?, tier_change = ?, settled_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(rank, tierChange, row.id);

          // Update user's league in game_state
          if (nextLeague !== league) {
            db.prepare('UPDATE game_state SET league = ? WHERE user_id = ?').run(nextLeague, row.user_id);
            // crosscheck4 #9: catch-up 延迟结算时，当周（以及任何尚未结算的后续
            // 周）的 leaderboard 行仍记着旧段位。把该用户所有未结算周的 league
            // 同步到新段位，否则当周排行滞留在过时段位，且后续周会按错误段位
            // 结算。只动 week_start > ws 的未结算行，绝不影响正在结算的 ws。
            db.prepare(`
              UPDATE leaderboard SET league = ?
              WHERE user_id = ? AND week_start > ? AND settled_at IS NULL
            `).run(nextLeague, row.user_id, ws);
          }

          // Insert history
          db.prepare(`
            INSERT OR REPLACE INTO league_history
              (user_id, week_start, league_from, league_to, final_rank, xp_earned, result)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(row.user_id, ws, league, nextLeague, rank, row.xp_earned,
                 rank === 1 && league === 'diamond' ? 'champion' : tierChange);

          settledRows.push({ user: row.username, league, nextLeague, rank, xp: row.xp_earned, change: tierChange });
        });
      }
    });
    console.log(`[settleWeek] Settling week ${ws}${force ? ' (force)' : ''}...`);
    tx();
  } catch (e) {
    settling = false;
    console.error(`[settleWeek] Failed for week ${ws}:`, e);
    throw e;
  }
  settling = false;

  console.log(`[settleWeek] Settled ${settledRows.length} entries for week ${ws}`);
  return { weekStart: ws, settled: settledRows };
}

// 联赛领奖闭环（crosscheck6 C high）：settleWeek 只写 final_rank/tier_change/settled_at，
// reward_claimed 从置 1——用户需主动领取段位奖励。按 tier_change 发币，单事务：
// champion +100 / promoted +60 / stay +30 / demoted +10。返回本周奖励，无可领返回 null。
const LEAGUE_REWARD = { champion: 100, promoted: 60, stay: 30, demoted: 10 };
function claimLeagueReward(userId) {
  const row = db.prepare(`
    SELECT id, week_start, league, final_rank, tier_change
    FROM leaderboard WHERE user_id = ? AND settled_at IS NOT NULL AND reward_claimed = 0
    ORDER BY week_start DESC LIMIT 1
  `).get(userId);
  if (!row) return null;
  const coins = LEAGUE_REWARD[row.tier_change || 'stay'] ?? 30;
  const tx = db.transaction(() => {
    // 原子：先置已领再发币，防重试双领（并发双领由 UPDATE ... WHERE reward_claimed=0 兜底）。
    const upd = db.prepare(`
      UPDATE leaderboard SET reward_claimed = 1
      WHERE id = ? AND reward_claimed = 0
    `).run(row.id);
    if (upd.changes === 0) return null; // 已被并发领走
    const gs = db.prepare('SELECT coins FROM game_state WHERE user_id = ?').get(userId);
    db.prepare('UPDATE game_state SET coins = ? WHERE user_id = ?').run((gs?.coins || 0) + coins, userId);
    return { weekStart: row.week_start, league: row.league, finalRank: row.final_rank, tierChange: row.tier_change, coins };
  });
  return tx();
}

// Startup catch-up: if the server was down at a Monday boundary, that week's
// settlement never ran. Find any leaderboard rows for weeks strictly before the
// current week that are still unsettled and settle them oldest-first.
function catchUpSettlements() {
  const currentWeek = getWeekStart();
  const staleWeeks = db.prepare(`
    SELECT DISTINCT week_start FROM leaderboard
    WHERE settled_at IS NULL AND week_start < ?
    ORDER BY week_start ASC
  `).all(currentWeek).map(r => r.week_start);

  if (!staleWeeks.length) return 0;
  let settled = 0;
  for (const ws of staleWeeks) {
    try {
      const res = settleWeek(ws);
      settled += (res.settled || []).length;
    } catch (e) {
      console.error(`[catchUpSettlements] week ${ws} failed:`, e);
    }
  }
  console.log(`[catchUpSettlements] Settled ${settled} stale entries across ${staleWeeks.length} week(s)`);
  return settled;
}

// === User-centric league info (used by /league/info endpoint) ===
function getLeagueInfo(userId) {
  const state = getGameState(userId);
  if (!state) return null;
  const league = state.league || 'bronze';
  const ws = getWeekStart();

  // User's TRUE weekly standing, queried directly from leaderboard — NOT derived
  // from a top-50 slice. When a league has >50 players, rank 51+ used to be
  // silently mis-ranked as xp_earned=0 and the promotion/demotion lines were
  // computed against a 0-XP-padded list (60-agent 性能审查). Same-xp ties now
  // share one rank instead of ordering arbitrarily.
  const myRow = db.prepare(
    `SELECT xp_earned FROM leaderboard WHERE week_start = ? AND league = ? AND user_id = ?`
  ).get(ws, league, userId);
  const myXP = myRow?.xp_earned ?? 0;
  const ahead = db.prepare(
    `SELECT COUNT(*) c FROM leaderboard WHERE week_start = ? AND league = ? AND xp_earned > ?`
  ).get(ws, league, myXP).c;
  const myRank = ahead + 1;
  const totalInLeague = Math.max(
    db.prepare(
      `SELECT COUNT(*) c FROM leaderboard WHERE week_start = ? AND league = ?`
    ).get(ws, league).c,
    myRank // a 0-XP participant has no leaderboard row yet — count them in
  );

  // Top-10 for the entries list (ghost-padded to 10 for small leagues).
  const realEntries = getLeaderboard(league, 50);
  const ghostEntries = generateGhostLeaderboard(league, 0, Math.max(0, 10 - realEntries.length), ws);
  const all = [...realEntries, ...ghostEntries].sort((a, b) => b.xp_earned - a.xp_earned);

  const rules = LEAGUE_RULES[league] || LEAGUE_RULES.bronze;
  // Same effective zones settlement uses (P26 P2) — the displayed promotion /
  // demotion boundaries must match what a settle would actually do, or a small
  // league shows "you'll promote!" for everyone while settle keeps them put.
  const { promote, demote } = effectiveZones(totalInLeague, rules);
  const promotionZoneEnd = promote;
  const demotionZoneStart = Math.max(1, totalInLeague - demote + 1);

  // Rank lines read with LIMIT 1 OFFSET so they stay correct past the top-50 cut.
  const rankXP = (rank) => {
    if (rank < 1 || rank > totalInLeague) return 0;
    return db.prepare(
      `SELECT xp_earned FROM leaderboard
       WHERE week_start = ? AND league = ? ORDER BY xp_earned DESC LIMIT 1 OFFSET ?`
    ).get(ws, league, rank - 1)?.xp_earned ?? 0;
  };
  const promoteThresholdXP = promote > 0 ? rankXP(promotionZoneEnd) : 0;
  const demoteSafeXP = demote > 0 ? rankXP(demotionZoneStart) : 0;
  const xpToPromotion = Math.max(0, promoteThresholdXP - myXP + 1);
  const xpAboveDemotion = Math.max(0, myXP - demoteSafeXP);

  return {
    league,
    week_start: ws,
    week_ends_at: getWeekEndsAt(),
    my_rank: myRank,
    my_xp: myXP,
    total_in_league: totalInLeague,
    promotion_zone_end: promotionZoneEnd,
    demotion_zone_start: demotionZoneStart,
    xp_to_promotion: promote > 0 ? xpToPromotion : 0,
    xp_above_demotion: demote > 0 ? xpAboveDemotion : 999,
    in_promotion_zone: myRank <= promotionZoneEnd && promote > 0,
    in_demotion_zone: myRank >= demotionZoneStart && demote > 0,
    entries: (() => {
      const top10 = all.slice(0, 10).map((e, i) => ({ ...e, rank: i + 1 }));
      // If the user is outside top 10, append their own entry (with separator marker)
      if (myRank > 10 && myXP > 0) {
        top10.push({ user_id: userId, username: state.username || '我', xp_earned: myXP, avatar: '👤', rank: myRank, is_below_fold: true });
      }
      return top10;
    })(),
  };
}

module.exports = {
  db,
  initializeDatabase,
  getUser,
  getGameState,
  getInventory,
  updateGameState,
  addXP,
  createSession,
  getUserByToken,
  deleteSession,
  deleteAllSessions,
  changePassword,
  setUserPassword,
  verifyPassword,
  getProgress,
  saveProgress,
  addMistake,
  addNodeResult,
  getNodeStats,
  getHardestNodes,
  getUserNodeStats,
  getUserLessonsStats,
  getUnreviewedMistakes,
  getUnclaimedReviewCredit,
  claimReviewCredit,
  getDueMistakeCount,
  getMistake,
  reviewMistake,
  dismissMistake,
  getLeaderboard,
  generateGhostLeaderboard,
  getWeekStart,
  getWeekEndsAt,
  todayShanghai,
  daysAgoShanghai,
  addLessonXP,
  settleWeek,
  claimLeagueReward,
  catchUpSettlements,
  getLeagueInfo,
  LEAGUE_ORDER,
  LEAGUE_RULES,
};
