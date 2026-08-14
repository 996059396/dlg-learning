// Assemble extracted chunks into u6_circuit_theory.json course unit
const fs = require('fs');
const path = require('path');

const __ROOT__ = path.resolve(__dirname, '..');
const EXT_DIR = path.join(__ROOT__, 'parser', 'extracted');
const OUT_FILE = path.join(__ROOT__, 'backend', 'data', 'courses', 'electrician_basics', 'u6_circuit_theory.json');

// Lesson plan: group chunks by topic into 6 lessons
// f0_* = 电路模型、电位、功率能量 (chunks from the base file)
// f1_* = 电阻、欧姆定律、电源、受控源 (chunks from file (1))
// f2_* = KCL/KVL 基尔霍夫定律 (chunks from file (2))
const LESSON_PLAN = [
  {
    id: 'l1_circuit_models',
    title: '电路模型与基本变量',
    description: '实际电路的抽象、电流电压电位的严格定义',
    estimated_time: '6分钟',
    sources: ['f0_001.json', 'f0_002.json', 'f0_003.json', 'f0_004.json'],
  },
  {
    id: 'l2_power_energy',
    title: '功率与能量：关联与非关联',
    description: '参考方向、吸收/发出功率的计算与判断',
    estimated_time: '6分钟',
    sources: ['f0_005.json', 'f0_006.json', 'f0_007.json', 'f0_008.json'],
  },
  {
    id: 'l3_ohm_deep',
    title: '欧姆定律的深水区',
    description: '适用范围、非关联负号、开路短路、功率限制',
    estimated_time: '6分钟',
    sources: ['f1_001.json', 'f1_002.json'],
  },
  {
    id: 'l4_sources',
    title: '理想电源的矛与盾',
    description: '电压源电流源的定义与四大禁忌（短路/开路/并联/串联）',
    estimated_time: '6分钟',
    sources: ['f1_003.json', 'f1_004.json'],
  },
  {
    id: 'l5_controlled_sources',
    title: '受控源与四种类型',
    description: 'CCCS/VCCS/VCVS/CCVS、三极管实例、量纲辨析',
    estimated_time: '5分钟',
    sources: ['f1_005.json'],
  },
  {
    id: 'l6_kirchhoff',
    title: '基尔霍夫定律 KCL/KVL',
    description: '两类约束、节点电流、回路电压、广义节点',
    estimated_time: '8分钟',
    sources: ['f2_001.json', 'f2_002.json', 'f2_003.json', 'f2_004.json', 'f2_005.json', 'f2_006.json', 'f2_007.json'],
  },
];

const unit = {
  id: 'u6_circuit_theory',
  title: '单元六：电路理论进阶（石群电路）',
  description: '基于石群教授《电路》（邱关源第五版）——参考方向、电源禁忌、受控源、基尔霍夫定律',
  icon: '🎓',
  course_id: 'electrician_basics',
  lessons: [],
};

let totalNodes = 0;

LESSON_PLAN.forEach(plan => {
  const nodes = [];
  plan.sources.forEach(src => {
    const fp = path.join(EXT_DIR, src);
    if (!fs.existsSync(fp)) {
      console.log('⚠️ missing: ' + src);
      return;
    }
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    data.forEach(n => nodes.push(n));
  });

  // Assign IDs
  nodes.forEach((n, i) => {
    n.id = `${plan.id}_n${i}`;
  });

  unit.lessons.push({
    id: plan.id,
    title: plan.title,
    description: plan.description,
    estimated_time: plan.estimated_time,
    nodes,
  });
  totalNodes += nodes.length;
  console.log(`${plan.id}: ${nodes.length} nodes`);
});

fs.writeFileSync(OUT_FILE, JSON.stringify(unit, null, 2));
console.log('═'.repeat(40));
console.log(`✅ u6_circuit_theory.json written: ${unit.lessons.length} lessons, ${totalNodes} nodes`);

// Register in index.json
const idxFile = path.join(__ROOT__, 'backend', 'data', 'courses', 'index.json');
const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
const course = idx.find(c => c.id === 'electrician_basics');
if (course && !course.units.find(u => u.id === 'u6_circuit_theory')) {
  course.units.push({
    id: 'u6_circuit_theory',
    title: unit.title,
    description: unit.description,
    lesson_count: unit.lessons.length,
    estimated_total_time: '37分钟',
  });
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
  console.log('✅ Registered u6 in index.json');
} else {
  console.log('ℹ️ u6 already registered or course missing');
}
