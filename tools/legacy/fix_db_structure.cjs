const fs = require('fs');
const path = require('path');

const basePath = path.join(__dirname, 'backend');

// 1. Give every node a unique ID
const courseFile = path.join(basePath, 'data/courses/electrician_basics/u1_meter_basics.json');
let courseData = JSON.parse(fs.readFileSync(courseFile, 'utf8'));
courseData.lessons.forEach(lesson => {
  lesson.nodes.forEach((node, idx) => {
    if (!node.id) {
      node.id = `${lesson.id}_n${idx}`;
    }
  });
});
fs.writeFileSync(courseFile, JSON.stringify(courseData, null, 2));
console.log('✅ Added unique IDs to all curriculum nodes.');

// 2. Kill the db outright to let it rebuild
fs.unlinkSync(path.join(basePath, 'data', 'app.db'));
fs.unlinkSync(path.join(basePath, 'data', 'app.db-shm'));
fs.unlinkSync(path.join(basePath, 'data', 'app.db-wal'));
console.log('✅ Dropped DB');

// 3. Update database.js model
const dbJsPath = path.join(basePath, 'models', 'database.js');
let dbJs = fs.readFileSync(dbJsPath, 'utf8');
dbJs = dbJs.replace(/node_index INTEGER NOT NULL/, 'node_id TEXT NOT NULL');
dbJs = dbJs.replace(/function addMistake\(userId, lessonId, nodeIndex, /g, 'function addMistake(userId, lessonId, nodeId, ');
dbJs = dbJs.replace(/node_index,/g, 'node_id,');
dbJs = dbJs.replace(/nodeIndex,/g, 'nodeId,');
fs.writeFileSync(dbJsPath, dbJs);
console.log('✅ Updated database.js schema.');

// 4. Update courses.js backend route
const crsPath = path.join(basePath, 'routes', 'courses.js');
let crsJs = fs.readFileSync(crsPath, 'utf8');
crsJs = crsJs.replace(/m.nodeIndex/g, 'm.nodeId');
fs.writeFileSync(crsPath, crsJs);
console.log('✅ Updated backend route to pass nodeId.');

// 5. Update game.js logic to fetch original_node by id
const gamePath = path.join(basePath, 'routes', 'game.js');
let gameJs = fs.readFileSync(gamePath, 'utf8');
gameJs = gameJs.replace(/lesson\.nodes\[mistake\.node_index\]/g, 'lesson.nodes.find(n => n.id === mistake.node_id)');
gameJs = gameJs.replace(/mistake\.node_index/g, 'mistake.node_id');
fs.writeFileSync(gamePath, gameJs);
console.log('✅ Updated game.js to use node_id searching.');

// 6. Update LessonPlayer.jsx in frontend
const lpPath = path.join(__dirname, 'frontend/src/pages/LessonPlayer.jsx');
let lpJs = fs.readFileSync(lpPath, 'utf8');
if (!lpJs.includes('nodeId: node?.id')) {
  lpJs = lpJs.replace(/nodeIndex: idx,/g, 'nodeId: node?.id || String(idx),\n      nodeIndex: idx,');
}
if(!lpJs.includes('nodeId: m.nodeId')) {
  lpJs = lpJs.replace(/nodeIndex: m\.nodeIndex,/g, 'nodeId: m.nodeId,\n            nodeIndex: m.nodeIndex,');
}
fs.writeFileSync(lpPath, lpJs);
console.log('✅ Updated LessonPlayer frontend to track node.id.');
