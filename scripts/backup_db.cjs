#!/usr/bin/env node
// 升级前快照：node scripts/backup_db.cjs [备注]
// 用 better-sqlite3 db.backup() 生成带时间戳的 app.db 一致性快照（WAL 下安全）。
// 每日自动备份由 server.js cron 承担（03:47 Asia/Shanghai → backend/models/data/backups/app-YYYYMMDD.db）。
// 示例：node scripts/backup_db.cjs before_c10_deploy
// ABI 预检：better-sqlite3 v13 预编译给 Node ABI 137，Node 20 直接段错误（与 server.js 同）。
if (Number(process.versions.modules) !== 137) {
  console.error(`[fatal] Node ABI = ${process.versions.modules}（需要 137）— 请用 Node 24 运行（node24\\node.exe scripts/backup_db.cjs）。`);
  process.exit(1);
}
const path = require('path');
const fs = require('fs');
const { db } = require('../backend/models/database');

const dir = process.env.DLG_BACKUP_DIR || path.join(__dirname, '..', 'backend', 'models', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const ts = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
const note = (process.argv[2] || 'snapshot').replace(/[^\w一-龥-]+/g, '_');
const dest = path.join(dir, `app-${ts}_${note}.db`);

db.backup(dest)
  .then(() => { console.log(`[backup] 快照完成 → ${dest}`); process.exit(0); })
  .catch((e) => { console.error('[backup] 失败:', e); process.exit(1); });
