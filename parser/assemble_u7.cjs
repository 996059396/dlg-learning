// Assemble new chunks (f04~f08) into u7_circuit_analysis.json
const fs = require('fs');
const path = require('path');

const EXT_DIR = 'D:/dlg_project/parser/extracted';
const OUT_FILE = 'D:/dlg_project/backend/data/courses/electrician_basics/u7_circuit_analysis.json';

const LESSON_PLAN = [
  {
    id: 'l1_equivalence',
    title: '等效变换与串并联',
    description: '二端网络对外等效、串并联对偶、混联剥洋葱',
    estimated_time: '7分钟',
    sources: ['f04_001.json', 'f04_002.json', 'f04_003.json', 'f04_004.json'],
  },
  {
    id: 'l2_wye_delta',
    title: 'Y-Δ 星三角变换与惠斯通电桥',
    description: '找肩膀口诀、RΔ=3RY、电桥平衡条件',
    estimated_time: '6分钟',
    sources: ['f05_001.json', 'f05_002.json', 'f05_003.json'],
  },
  {
    id: 'l3_source_transform',
    title: '实际电源的两种模型与等效互换',
    description: 'Us=Is·Rs、开路电压短路电流、变换方向规则',
    estimated_time: '8分钟',
    sources: ['f06_001.json', 'f06_002.json', 'f06_003.json', 'f06_004.json', 'f06_005.json'],
  },
  {
    id: 'l4_input_resistance',
    title: '输入电阻与受控源化简',
    description: '外加电源法、电源置零规则、负电阻的诞生',
    estimated_time: '7分钟',
    sources: ['f07_001.json', 'f07_002.json', 'f07_003.json', 'f07_004.json'],
  },
  {
    id: 'l5_graph_theory',
    title: '电路的图与独立方程数',
    description: '树/树枝/连支、KCL 独立数 n-1、KVL 独立数 b-n+1',
    estimated_time: '7分钟',
    sources: ['f08_001.json', 'f08_002.json', 'f08_003.json'],
  },
  {
    id: 'l6_branch_current',
    title: '支路电流法实战',
    description: '方程总数=b、无伴电流源技巧、含受控源两步法',
    estimated_time: '7分钟',
    sources: ['f08_004.json', 'f08_005.json', 'f08_006.json'],
  },
];

const unit = {
  id: 'u7_circuit_analysis',
  title: '单元七：电路分析方法（石群电路II）',
  description: '等效变换、Y-Δ、电源互换、输入电阻、图论与支路电流法——邱关源第二三章精髓',
  icon: '📐',
  course_id: 'electrician_basics',
  lessons: [],
};

let totalNodes = 0;
LESSON_PLAN.forEach(plan => {
  const nodes = [];
  plan.sources.forEach(src => {
    const fp = path.join(EXT_DIR, src);
    if (!fs.existsSync(fp)) { console.log('⚠️ missing: ' + src); return; }
    JSON.parse(fs.readFileSync(fp, 'utf8')).forEach(n => nodes.push(n));
  });
  nodes.forEach((n, i) => { n.id = `${plan.id}_n${i}`; });
  unit.lessons.push({
    id: plan.id, title: plan.title, description: plan.description,
    estimated_time: plan.estimated_time, nodes,
  });
  totalNodes += nodes.length;
  console.log(`${plan.id}: ${nodes.length} nodes`);
});

fs.writeFileSync(OUT_FILE, JSON.stringify(unit, null, 2));
console.log('═'.repeat(40));
console.log(`✅ u7_circuit_analysis.json: ${unit.lessons.length} lessons, ${totalNodes} nodes`);

// Register in index.json
const idxFile = 'D:/dlg_project/backend/data/courses/index.json';
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
const course = idx.find(c => c.id === 'electrician_basics');
if (course && !course.units.find(u => u.id === 'u7_circuit_analysis')) {
  course.units.push({
    id: 'u7_circuit_analysis',
    title: unit.title,
    description: unit.description,
    lesson_count: unit.lessons.length,
    estimated_total_time: '42分钟',
  });
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
  console.log('✅ Registered u7 in index.json');
}
