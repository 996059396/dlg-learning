const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'app.db');

try {
  const db = new Database(dbPath);
  db.exec('DELETE FROM mistakes; DELETE FROM progress;');
  console.log('✅ 清空了受旧索引污染的错题本和进度表数据');
  db.close();
} catch (e) {
  console.log('Error cleaning mistakes:', e.message);
}
