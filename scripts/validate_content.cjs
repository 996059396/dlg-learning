#!/usr/bin/env node
// 内容回归校验器 — Task #8
// 全部 11 单元课程数据的完整性扫描。CI/发布门禁：有 ERROR 即 exit 1。
//
// 覆盖(除结构检查外，额外锁定历史回归):
//  - multimeter_challenge 缺 correct_display 即 fail(审计 B14/W3 要求)
//  - correct_setup.dial 类别必须匹配 target.type(档位↔目标错配回归锁)
//  - correct_display 数值必须落在目标标称值的合理容差内(读数断言回归锁)
//  - fill_blank 缺 answer 即 fail
//  - 全局 node id 唯一(错题医疗箱按 id 回溯，重复会串题)
//  - 课节标题不得是占位符(对偶原理/卷积与状态方程 系列)
//  - 路径由 __dirname 推导，cwd 无关
'use strict';

const fs = require('fs');
const path = require('path');

const COURSES_ROOT = path.resolve(__dirname, '../backend/data/courses');
const courseDirs = fs.readdirSync(COURSES_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const VALID_DIAL_IDS = new Set([
  'OFF', 'hFE', 'NCV',
  'OHM_200', 'OHM_2K', 'OHM_20K', 'OHM_200K', 'OHM_2M', 'OHM_20M',
  'DIODE', 'TEMP',
  'CAP_200N', 'CAP_2U', 'CAP_20U', 'CAP_200U',
  'FREQ',
  'A20', 'A200M',
  'DCA_200U', 'DCA_2M', 'DCA_20M', 'DCA_200M',
  'ACA',
  'DCV_200M', 'DCV_2', 'DCV_20', 'DCV_200', 'DCV_1000',
  'ACV_2', 'ACV_20', 'ACV_200', 'ACV_750'
]);
const VALID_PORT_IDS = new Set(['20A', 'mA', 'COM', 'VOhm']);
const VALID_NODE_TYPES = new Set([
  'info', 'multiple_choice', 'true_false', 'fill_blank', 'match', 'sort',
  'drag_drop', 'simulation_dial', 'simulation_probe', 'simulation_danger',
  'multimeter_challenge', 'multi_select'
]);
// 占位标题回归锁(u9/u10 曾整批使用占位标题)
const PLACEHOLDER_TITLE = /^(对偶原理|卷积与状态方程)(\s*\(\d+\))?$/;

// 目标类型 → 允许的档位前缀集合(防止 correct_setup 档位与测量目标类别错配)
// DCA 类别含 DCA_200U~200M 与 20A 大电流档 A20/A200M
const TARGET_DIAL_PREFIX = {
  socket_220v: ['ACV'], wall_outlet_220v: ['ACV'], breaker_output: ['ACV'],
  battery_9v: ['DCV'], battery_aa_1v5: ['DCV'], old_battery_1v5: ['DCV'],
  car_battery_12v: ['DCV'], unknown_dc_terminal: ['DCV'],
  resistor_1k: ['OHM'], unknown_resistor: ['OHM'],
  capacitor_100uf: ['CAP'],
  power_cord_test: ['DIODE'], extension_cord_wire: ['DIODE'],
  led_circuit: ['DCA'], dc_motor_circuit: ['DCA', 'A'], buzzer_circuit: ['DCA'],
};
// 目标类型 → 标称值(基本单位 Ω/V/A/F)，用于读数断言
const TARGET_VALUE = {
  socket_220v: 220, wall_outlet_220v: 220, breaker_output: 220,
  battery_9v: 9, battery_aa_1v5: 1.5, old_battery_1v5: 1.5, car_battery_12v: 12,
  unknown_dc_terminal: 24,
  resistor_1k: 1000, unknown_resistor: 853000,
  capacitor_100uf: 1e-4,
  power_cord_test: 0,
  led_circuit: 0.0198, dc_motor_circuit: 1.05, buzzer_circuit: 0.078,
};

const errors = [];
const warnings = [];
let totalNodes = 0;
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// 后缀 → 基本单位乘子(Ω/V/A/F 基准)
const SUFFIX_MULT = {
  '': 1, 'Ω': 1, 'kΩ': 1e3, 'MΩ': 1e6,
  'V': 1, 'mV': 1e-3, 'kV': 1e3,
  'A': 1, 'mA': 1e-3, 'μA': 1e-6, 'µA': 1e-6, 'kA': 1e3,
  'F': 1, 'mF': 1e-3, 'μF': 1e-6, 'µF': 1e-6, 'nF': 1e-9,
};
const readDisplayValue = (display) => {
  if (typeof display !== 'string') return null;
  const m = display.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-ZµμΩ]*)/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const mult = SUFFIX_MULT[m[2]] ?? (m[2] === '' ? 1 : null);
  if (mult === null) return null;
  return num * mult;
};

console.log('🔍 课程内容回归校验');
console.log('═'.repeat(52));

const allNodeIds = new Set();

for (const dir of courseDirs) {
  const DIR = path.join(COURSES_ROOT, dir);
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();

for (const file of files) {
  const fp = path.join(DIR, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    err(`[${dir}] ${file}: JSON 解析失败 - ${e.message}`);
    continue;
  }
  const unit = Array.isArray(data) ? data[0] : (data.units || [data])[0];
  if (!unit || !Array.isArray(unit.lessons)) {
    err(`[${dir}] ${file}: 缺少 lessons 数组`);
    continue;
  }
  const lessonIds = new Set();
  let fileNodeCount = 0;
  const fileErrStart = errors.length;

  unit.lessons.forEach((lesson, li) => {
    const lessonId = lesson.id;
    if (!lessonId) { err(`${file} > lesson[${li}]: 缺 id`); return; }
    if (lessonIds.has(lessonId)) err(`${file} > lesson[${li}]: id="${lessonId}" 在本单元重复`);
    lessonIds.add(lessonId);
    if (!lesson.title) err(`${file} > ${lessonId}: 缺课节标题`);
    if (PLACEHOLDER_TITLE.test(lesson.title || ''))
      err(`${file} > ${lessonId}: 标题「${lesson.title}」是占位符`);
    if (!Array.isArray(lesson.nodes)) { err(`${file} > ${lessonId}: 缺 nodes`); return; }

    const lessonNodeIds = new Set();
    lesson.nodes.forEach((node, idx) => {
      fileNodeCount++;
      totalNodes++;
      const ctx = `${file} > ${lessonId} > node[${idx}]`;
      if (!node.id) { err(`${ctx}: 缺失 id 字段`); return; }
      // 全局唯一(错题医疗箱按 id 回溯)
      if (allNodeIds.has(node.id)) err(`${ctx}: id="${node.id}" 跨单元重复`);
      allNodeIds.add(node.id);
      if (lessonNodeIds.has(node.id)) err(`${ctx}: id="${node.id}" 在 lesson 内重复`);
      lessonNodeIds.add(node.id);
      const expectedId = `${lessonId}_n${idx}`;
      if (node.id !== expectedId) warn(`${ctx}: id="${node.id}" 不符合规范，期望 "${expectedId}"`);

      if (!node.type) { err(`${ctx}: 缺失 type`); return; }
      if (!VALID_NODE_TYPES.has(node.type)) { err(`${ctx}: 非法 type="${node.type}"`); return; }

      switch (node.type) {
        case 'info':
          if (!node.title) warn(`${ctx} (info): 缺 title`);
          if (!node.content) err(`${ctx} (info): 缺 content`);
          else if (node.content.length < 30) warn(`${ctx} (info): content 过短 (${node.content.length} 字)`);
          break;
        case 'multiple_choice': {
          if (!node.question) err(`${ctx} (mc): 缺 question`);
          if (!Array.isArray(node.options) || node.options.length < 2) { err(`${ctx} (mc): options 少于 2`); break; }
          const correctOpts = node.options.filter(o => o.is_correct);
          if (correctOpts.length === 0) err(`${ctx} (mc): 无 is_correct=true 选项`);
          if (correctOpts.length > 1) warn(`${ctx} (mc): ${correctOpts.length} 个正确选项`);
          node.options.forEach((o, oi) => { if (!o.text || !o.text.trim()) err(`${ctx} (mc) option[${oi}]: 空 text`); });
          if (new Set(node.options.map(o => o.text)).size !== node.options.length)
            warn(`${ctx} (mc): options 有重复文本`);
          break;
        }
        case 'multi_select': {
          // 真考 多选题: 必须 ≥2 个正确选项才算「多选」, 且至少 1 个干扰项。
          if (!node.question) err(`${ctx} (ms): 缺 question`);
          if (!Array.isArray(node.options) || node.options.length < 3) { err(`${ctx} (ms): options 少于 3`); break; }
          const correctOpts = node.options.filter(o => o.is_correct);
          if (correctOpts.length < 2) err(`${ctx} (ms): 正确选项少于 2 (须为多选)`);
          if (correctOpts.length === node.options.length) err(`${ctx} (ms): 全部选项都正确 (无干扰项)`);
          node.options.forEach((o, oi) => { if (!o.text || !o.text.trim()) err(`${ctx} (ms) option[${oi}]: 空 text`); });
          if (new Set(node.options.map(o => o.text)).size !== node.options.length)
            warn(`${ctx} (ms): options 有重复文本`);
          break;
        }
        case 'true_false':
          if (!node.question) err(`${ctx} (tf): 缺 question`);
          if (typeof node.correct_answer !== 'boolean') err(`${ctx} (tf): correct_answer 不是 bool`);
          break;
        case 'fill_blank':
          if (!node.question) err(`${ctx} (fb): 缺 question`);
          if (!node.answer || !String(node.answer).trim()) err(`${ctx} (fb): 缺 answer`);
          if (!Array.isArray(node.acceptable_answers) || node.acceptable_answers.length === 0)
            err(`${ctx} (fb): acceptable_answers 为空`);
          break;
        case 'match':
          if (!node.question) err(`${ctx} (match): 缺 question`);
          if (!Array.isArray(node.pairs) || node.pairs.length < 2) err(`${ctx} (match): pairs 少于 2`);
          else node.pairs.forEach((p, pi) => { if (!p.left || !p.right) err(`${ctx} (match) pair[${pi}]: 缺 left 或 right`); });
          break;
        case 'sort':
          if (!Array.isArray(node.items) || node.items.length < 2) err(`${ctx} (sort): items 少于 2`);
          if (!Array.isArray(node.correct_order)) err(`${ctx} (sort): correct_order 不是数组`);
          else {
            const ids = new Set((node.items || []).map(i => i.id));
            node.correct_order.forEach(oid => { if (!ids.has(oid)) err(`${ctx} (sort): correct_order 含未知 id="${oid}"`); });
          }
          break;
        case 'drag_drop':
          if (!node.target_zone || !node.target_zone.id) err(`${ctx} (dd): 缺 target_zone.id`);
          if (!Array.isArray(node.distractors)) err(`${ctx} (dd): distractors 不是数组`);
          break;
        case 'simulation_dial':
          if (!Array.isArray(node.dial_options)) err(`${ctx} (sd): dial_options 不是数组`);
          else if (!node.dial_options.some(d => d.is_correct)) err(`${ctx} (sd): 无 is_correct=true 档位`);
          break;
        case 'simulation_probe':
          if (!node.hotspots) err(`${ctx} (sp): 缺 hotspots`);
          if (!node.correct_probes) err(`${ctx} (sp): 缺 correct_probes`);
          else {
            const hs = Object.keys(node.hotspots || {});
            ['red', 'black'].forEach(k => {
              if (node.correct_probes[k] && !hs.includes(node.correct_probes[k]))
                err(`${ctx} (sp): correct_probes.${k}="${node.correct_probes[k]}" 不在 hotspots`);
            });
          }
          break;
        case 'simulation_danger':
          if (!node.correct_sequence) err(`${ctx} (sdng): 缺 correct_sequence`);
          break;
        case 'multimeter_challenge': {
          if (!node.target) err(`${ctx} (mmc): 缺 target`);
          if (!node.target?.hotspots) err(`${ctx} (mmc): 缺 target.hotspots`);
          // ⭐ 审计要求:缺 correct_display 即 fail
          if (!node.correct_display || !String(node.correct_display).trim())
            err(`${ctx} (mmc): 缺 correct_display`);
          if (!node.correct_setup) { err(`${ctx} (mmc): 缺 correct_setup`); break; }
          const cs = node.correct_setup;
          ['dial', 'red_port', 'black_port', 'red_touch', 'black_touch'].forEach(k => {
            if (!cs[k]) err(`${ctx} (mmc): correct_setup.${k} 缺失`);
          });
          if (cs.dial && !VALID_DIAL_IDS.has(cs.dial)) err(`${ctx} (mmc): dial="${cs.dial}" 非组件支持档位`);
          if (cs.red_port && !VALID_PORT_IDS.has(cs.red_port)) err(`${ctx} (mmc): red_port="${cs.red_port}" 非法`);
          if (cs.black_port && !VALID_PORT_IDS.has(cs.black_port)) err(`${ctx} (mmc): black_port="${cs.black_port}" 非法`);
          if (cs.black_port && cs.black_port !== 'COM') err(`${ctx} (mmc): black_port 必须为 COM`);
          // ⭐ 档位类别必须匹配目标类型
          const ttype = node.target?.type;
          const allowedPrefixes = TARGET_DIAL_PREFIX[ttype];
          if (allowedPrefixes && cs.dial && !allowedPrefixes.some(p => cs.dial.startsWith(p))) {
            err(`${ctx} (mmc): target=${ttype} 期望 ${allowedPrefixes.join('/')} 档，实际 dial="${cs.dial}"`);
          }
          // ⭐ 读数断言:correct_display 数值应落在目标标称值的合理容差内
          const nominal = TARGET_VALUE[ttype];
          if (nominal !== undefined && typeof node.correct_display === 'string') {
            const disp = node.correct_display.trim();
            const got = readDisplayValue(disp);
            if (got === null) {
              // 非数字标记(如断路显示的 "OL")放行，其余无法解析的读数判错
              if (!/^(OL|∞|---)/.test(disp)) {
                err(`${ctx} (mmc): correct_display 无法解析数值: "${node.correct_display}"`);
              }
            } else {
              const tol = Math.max(0.25 * nominal, 0.5);
              if (Math.abs(got - nominal) > tol) {
                err(`${ctx} (mmc): correct_display="${node.correct_display}" ≈ ${got} 超出 ${ttype} 标称 ${nominal} 容差 ±${tol.toFixed(2)}`);
              }
            }
          }
          if (node.target?.hotspots && cs.red_touch) {
            const hs = Array.isArray(node.target.hotspots)
              ? node.target.hotspots.map(h => h.id)
              : Object.keys(node.target.hotspots);
            if (!hs.includes(cs.red_touch)) err(`${ctx} (mmc): red_touch="${cs.red_touch}" 不在 hotspots`);
            if (cs.black_touch && !hs.includes(cs.black_touch)) err(`${ctx} (mmc): black_touch="${cs.black_touch}" 不在 hotspots`);
          }
          break;
        }
      }
      if (node.question === '') warn(`${ctx}: question 为空字符串`);
    });
  });

  const fileErrCount = errors.length - fileErrStart;
  console.log(`  [${dir}] ${file}: ${unit.lessons.length} lessons / ${fileNodeCount} nodes${fileErrCount ? `  ❌ ${fileErrCount} err` : ''}`);
  }
}

// ── 模拟考多选题池(exam 引擎专用, 不入课程 lesson)──
// 全局 id 唯一性纳入同一 allNodeIds 注册表, 防止与课程节点撞 id。
const MS_POOL = path.resolve(__dirname, '../backend/data/exam/multi_select.json');
if (fs.existsSync(MS_POOL)) {
  const pool = JSON.parse(fs.readFileSync(MS_POOL, 'utf8'));
  if (!Array.isArray(pool)) err('multi_select.json: 顶层须为数组');
  else pool.forEach((node, i) => {
    totalNodes++;
    const ctx = `multi_select.json > [${i}]`;
    if (!node.id) { err(`${ctx}: 缺失 id`); return; }
    if (allNodeIds.has(node.id)) err(`${ctx}: id="${node.id}" 与课程节点重复`);
    allNodeIds.add(node.id);
    if (!VALID_NODE_TYPES.has(node.type)) err(`${ctx}: 非法 type="${node.type}"`);
    if (node.type === 'multi_select') {
      if (!node.question) err(`${ctx} (ms): 缺 question`);
      if (!Array.isArray(node.options) || node.options.length < 3) err(`${ctx} (ms): options 少于 3`);
      else {
        const correctOpts = node.options.filter(o => o.is_correct);
        if (correctOpts.length < 2) err(`${ctx} (ms): 正确选项少于 2 (须为多选)`);
        if (correctOpts.length === node.options.length) err(`${ctx} (ms): 全部选项都正确`);
        node.options.forEach((o, oi) => { if (!o.text || !o.text.trim()) err(`${ctx} (ms) option[${oi}]: 空 text`); });
      }
    } else err(`${ctx}: 池内只允许 multi_select, 实际 "${node.type}"`);
  });
}

console.log('\n' + '═'.repeat(52));
console.log(`📊 总计: ${errors.length} ERROR / ${warnings.length} WARN / ${totalNodes} 节点`);

if (errors.length) {
  console.log('\n❌ ERRORS:');
  errors.slice(0, 60).forEach(e => console.log('  ' + e));
  if (errors.length > 60) console.log(`  ... 还有 ${errors.length - 60} 条`);
}
if (warnings.length) {
  console.log(`\n⚠️ ${warnings.length} 条 WARN(前 20 条):`);
  warnings.slice(0, 20).forEach(w => console.log('  ' + w));
}

process.exit(errors.length > 0 ? 1 : 0);
