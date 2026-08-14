const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'backend', 'data', 'app.db');

try {
  const db = new Database(dbPath);
  db.exec('DELETE FROM mistakes;');
  console.log('✅ 数据库被占用解触，清空所有的残余错题记录');
  db.close();
} catch (e) {
  console.log('Error cleaning mistakes:', e.message);
}
