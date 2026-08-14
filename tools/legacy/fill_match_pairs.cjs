// Fill missing match pairs in u3_tools.json
const fs = require('fs');
const path = require('path');
const fp = path.join(__dirname, 'backend', 'data', 'courses', 'electrician_basics', 'u3_tools.json');
const data = JSON.parse(fs.readFileSync(fp, 'utf8'));

const fills = {
  'l1_pliers': {
    nodeIdx: 8,
    pairs: [
      { left: '钢丝钳 (老虎钳)', right: '剪线、夹持、弯折导线' },
      { left: '尖嘴钳 (细嘴钳)', right: '狭小空间夹小元件、弯线圈' },
      { left: '斜口钳 (断线钳)', right: '快速剪断硬度高的细金属丝' },
      { left: '电工刀', right: '剥大线径电线的绝缘层（断电下）' }
    ]
  },
  'l2_screwdriver': {
    nodeIdx: 14,
    pairs: [
      { left: '尖端十字花型', right: '十字螺丝刀（PH 系列）' },
      { left: '尖端单一直线槽', right: '一字螺丝刀' },
      { left: '尾部金属帽贯通刀身', right: '穿心螺丝刀（带电禁用！）' },
      { left: '内置氖管+电阻', right: '试电笔（验电用）' }
    ]
  },
  'l3_wire_stripper': {
    nodeIdx: 8,
    pairs: [
      { left: '剥 0.8mm 细信号线', right: '剥线钳 0.8mm 齿孔' },
      { left: '剥 2.5mm² BVR 软线', right: '剥线钳 2.4mm 齿孔' },
      { left: '剥 25mm² 粗主线绝缘层', right: '电工刀（剥线钳超量程）' },
      { left: '把 35mm² 铜端子压死', right: '液压钳（强压一体）' }
    ]
  },
  'l4_heavy_tools': {
    nodeIdx: 8,
    pairs: [
      { left: '长口锤 0.125kg', right: '配电箱内拧紧小型钉脚' },
      { left: '圆头锤 0.5kg', right: '一般敲打、装钉、矫正轻金属' },
      { left: '圆头锤 1kg 以上', right: '砸地桩、敲混凝土膨胀栓' },
      { left: '橡胶/木锤', right: '不伤设备表面的轻力敲击' }
    ]
  }
};

let count = 0;
Object.entries(fills).forEach(([lessonId, { nodeIdx, pairs }]) => {
  const lesson = data.lessons.find(l => l.id === lessonId);
  if (lesson && lesson.nodes[nodeIdx]) {
    lesson.nodes[nodeIdx].pairs = pairs;
    lesson.nodes[nodeIdx].instruction = lesson.nodes[nodeIdx].instruction || '点击左侧再点右侧完成连线';
    count++;
    console.log(`✅ ${lessonId} node[${nodeIdx}]: 补充 ${pairs.length} 个 pair`);
  }
});

fs.writeFileSync(fp, JSON.stringify(data, null, 2));
console.log(`\n📊 共补充 ${count} 道 match 题`);
