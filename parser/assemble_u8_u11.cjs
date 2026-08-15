// Assemble f09~f41 micro-learning chunks into units u8~u11
const fs = require('fs');
const path = require('path');

const EXT_DIR = process.env.DLG_EXT_DIR || require('path').join(__dirname, 'extracted');
const COURSE_DIR = process.env.DLG_COURSE_DIR || require('path').join(__dirname, '..', 'backend', 'data', 'courses', 'electrician_basics');

// Helper: collect nodes from a list of file prefixes
function collect(prefixes) {
  const nodes = [];
  const files = fs.readdirSync(EXT_DIR).filter(f => prefixes.some(p => f.startsWith(p))).sort();
  files.forEach(f => {
    JSON.parse(fs.readFileSync(path.join(EXT_DIR, f), 'utf8')).forEach(n => nodes.push(n));
  });
  return nodes;
}

// Split nodes array into lessons of ~15-18 nodes, breaking at info boundaries when possible
function splitIntoLessons(nodes, lessonPrefix, titles) {
  const lessons = [];
  let current = [];
  let lessonIdx = 0;

  nodes.forEach(n => {
    // Start new lesson at info nodes if current is already large
    if (n.type === 'info' && current.length >= 14) {
      lessons.push(current);
      current = [];
    }
    current.push(n);
    // Hard cap
    if (current.length >= 20) {
      lessons.push(current);
      current = [];
    }
  });
  if (current.length > 0) {
    // Merge tiny tail into last lesson
    if (current.length < 6 && lessons.length > 0) {
      lessons[lessons.length - 1].push(...current);
    } else {
      lessons.push(current);
    }
  }

  return lessons.map((nodeList, i) => {
    const id = `${lessonPrefix}_l${i + 1}`;
    nodeList.forEach((n, j) => { n.id = `${id}_n${j}`; });
    const title = titles[i] || (titles[titles.length-1] + ` (${i + 2 - titles.length})`);
    return {
      id,
      title,
      description: nodeList[0]?.type === 'info' ? (nodeList[0].title || '') : '',
      estimated_time: Math.ceil(nodeList.length * 0.4) + '分钟',
      nodes: nodeList,
    };
  });
}

const UNITS = [
  {
    id: 'u8_network_methods',
    title: '单元八：网络分析方法（微学习）',
    description: '回路电流法、节点电压法、叠加定理、齐性定理——小步快跑循序渐进',
    icon: '🧮',
    prefixes: ['f09_', 'f10_', 'f11_', 'f12_', 'f13_'],
    titles: ['电路的图与树', '网孔电流法', '回路电流法', '节点电压法', '巧选接地点', '功率守恒验证', '叠加定理', '功率不可叠加', '齐性定理', '克莱姆法则'],
  },
  {
    id: 'u9_theorems',
    title: '单元九：电路定理精讲（微学习）',
    description: '替代定理、戴维宁、诺顿、最大功率传输、互易对偶——一题一知识点',
    icon: '⭐',
    prefixes: ['f14_', 'f15_', 'f16_', 'f17_'],
    titles: ['替代定理', '替代的失效情形', '戴维宁定理', '开路电压与短路电流', '等效电阻三法', '诺顿定理', '最大功率传输', '互易定理', '对偶原理'],
  },
  {
    id: 'u10_opamp_dynamics',
    title: '单元十：运放与动态电路（微学习）',
    description: '虚短虚断、电容电感、一阶二阶电路、三要素法、阶跃冲激响应',
    icon: '⏳',
    prefixes: ['f18_', 'f19_', 'f20_', 'f21_', 'f22_', 'f23_', 'f24_', 'f25_', 'f26_', 'f27_', 'f28_', 'f29_', 'f30_', 'f31_', 'f32_'],
    titles: ['运放基础', '虚短与虚断', '典型运放电路', '电容元件', '电感元件', '串并联等效', '动态电路入门', '换路定则', '零输入响应', '时间常数', '零状态响应', '全响应', '三要素法', '二阶电路', '阻尼四态', '阶跃响应', '冲激响应', '卷积与状态方程'],
  },
  {
    id: 'u11_ac_analysis',
    title: '单元十一：正弦稳态分析（微学习）',
    description: '复数、相量法、阻抗导纳、功率因数、复功率、最大功率匹配',
    icon: '🌊',
    prefixes: ['f33_', 'f34_', 'f35_', 'f36_', 'f37_', 'f38_', 'f39_', 'f40_', 'f41_'],
    titles: ['复数基础', '正弦量三要素', '有效值', '相量法', '电感电容相量', 'KCL/KVL相量形式', '阻抗与导纳', '阻抗三角形', '混联阻抗实战', '相量图', '功率因数', '有功无功视在', '无功补偿', '复功率', '共轭匹配与模匹配'],
  },
];

const indexFile = process.env.DLG_INDEX_FILE || require('path').join(__dirname, '..', 'backend', 'data', 'courses', 'index.json');
const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const course = idx.find(c => c.id === 'electrician_basics');

UNITS.forEach(u => {
  const nodes = collect(u.prefixes);
  const lessons = splitIntoLessons(nodes, u.id, u.titles);
  const unit = {
    id: u.id,
    title: u.title,
    description: u.description,
    icon: u.icon,
    course_id: 'electrician_basics',
    lessons,
  };
  fs.writeFileSync(path.join(COURSE_DIR, u.id + '.json'), JSON.stringify(unit, null, 2));
  const totalNodes = lessons.reduce((s, l) => s + l.nodes.length, 0);
  console.log(`✅ ${u.id}: ${lessons.length} lessons, ${totalNodes} nodes`);

  if (!course.units.find(x => x.id === u.id)) {
    course.units.push({
      id: u.id,
      title: u.title,
      description: u.description,
      lesson_count: lessons.length,
      estimated_total_time: Math.ceil(totalNodes * 0.4) + '分钟',
    });
  }
});

fs.writeFileSync(indexFile, JSON.stringify(idx, null, 2));
console.log('✅ index.json updated with 4 new units');
