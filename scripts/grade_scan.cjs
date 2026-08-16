#!/usr/bin/env node
// Full-curriculum grading scan v2: build the correct answer in the EXACT format
// the frontend serializes (per grading.js comments), feed through gradeNode().
// Any node whose canonical answer doesn't self-grade 100% is a content or
// grading bug — this is the "will a perfect learner always pass" canary.
const fs = require('fs'); const path = require('path');
const { gradeNode } = require(path.join(__dirname, '..', 'backend', 'lib', 'grading.js'));
const ROOT = path.join(__dirname, '..', 'backend', 'data', 'courses');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json') && e.name !== 'index.json') files.push(p);
  }
})(ROOT);
// Mock-exam multi_select pool lives outside the course dirs — scan it too.
const msPool = path.join(__dirname, '..', 'backend', 'data', 'exam', 'multi_select.json');
if (fs.existsSync(msPool)) files.push(msPool);

// Per-file total node counts (canary: a content edit that accidentally DELETES
// or DUPLICATES whole nodes must bump this map — the scan fails otherwise).
// Update the value deliberately when a recut is intended; the scan prints the
// live count on mismatch so the correction is copy-paste easy.
const EXPECTED_NODE_COUNTS = {
  'u10_opamp_dynamics.json': 1300, 'u11_ac_analysis.json': 920, 'u12_three_phase.json': 9,
  'u1_meter_basics.json': 88, 'u2_circuit_basics.json': 70,
  'u3_tools.json': 57, 'u4_relays.json': 55,
  'u5_multimeter_advanced.json': 75, 'u6_circuit_theory.json': 137,
  'u7_circuit_analysis.json': 116, 'u8_network_methods.json': 441,
  'u9_theorems.json': 477,
  's1_safety_firstaid.json': 50, 's2_meters.json': 50, 's3_motor_control.json': 63,
  's4_distribution_safety.json': 55, 's5_lighting_install.json': 53,
  's6_diagram_substation.json': 54, 's7_motor_basics.json': 50,
  's8_grounding_lightning_cable.json': 52, 's9_hv_substation.json': 50,
  's10_electronics.json': 50, 's11_vfd_plc.json': 50,
  's12_lv_switchgear.json': 50, 's13_mock_exam.json': 50,
  'e0_elementary.json': 133, 'e1_middle_school.json': 143,
  'e2_high_school.json': 145, 'e3_transition.json': 147,
  'multi_select.json': 39,
};
// simulation_dial dial_options carry real dial angles (°). Two options at the
// same / overlapping angle is an authoring error (duplicate positions, labels
// that would overlap). The renderer positions by index today, so this is a
// data-quality canary: options must keep a minimum angular separation.
const MIN_DIAL_ANGLE_GAP = 15;

function correctAnswer(n) {
  switch (n.type) {
    case 'multiple_choice': { const o = (n.options || []).find(o => o.is_correct); return o ? o.text : null; }
    case 'multi_select': return JSON.stringify((n.options || []).filter(o => o.is_correct).map(o => String(o.id || o.text)));
    case 'true_false': return n.correct_answer ? '正确' : '错误';
    case 'fill_blank': return (n.acceptable_answers && n.acceptable_answers[0]) || n.answer || null;
    case 'match': return (n.pairs || []).map(p => `${p.left} = ${p.right}`).join(', ');
    case 'sort': return (n.correct_order || []).map(id => (n.items || []).find(i => i.id === id)?.text).filter(Boolean).join(' → ');
    case 'drag_drop': return n.target_zone?.label || null;
    case 'simulation_dial': return (n.dial_options || []).find(o => o.is_correct)?.label || null;
    case 'simulation_danger': return '安全操作';
    case 'simulation_probe': {
      if (!n.correct_probes) return null;
      return `红:${n.correct_probes.red}, 黑:${n.correct_probes.black}`;
    }
    case 'multimeter_challenge': {
      const c = n.correct_setup; if (!c) return null;
      const hs = n.target?.hotspots || {};
      const lbl = (k) => (hs[k] && hs[k].label) ? hs[k].label : (Array.isArray(hs) ? (hs.find(h => h && h.id === k)?.label) : k);
      return `档位:${c.dial}, 红:${c.red_port}→${lbl(c.red_touch)}, 黑:${c.black_port}→${lbl(c.black_touch)}`;
    }
    default: return null;
  }
}

// 构造一个「必错」答案（crosscheck5 X M9 错答负例）：若无法构造保证错的答案返回
// null 跳过。判分若把这些错答判对，说明 grading 出现宽容化回归（如 SI 前缀 M/m
// 融合、全角归一化失效），门禁必须变红。
function wrongAnswer(n) {
  switch (n.type) {
    case 'multiple_choice': {
      const wrong = (n.options || []).find(o => !o.is_correct);
      return wrong ? wrong.text : null;
    }
    case 'multi_select': {
      const corr = (n.options || []).filter(o => o.is_correct);
      if (corr.length === 0) return null;
      // 正确集 ≥2 → 只选 1 个必错；=1 → 空集必错
      return corr.length >= 2 ? JSON.stringify([String(corr[0].id || corr[0].text)]) : JSON.stringify([]);
    }
    case 'true_false': return n.correct_answer ? '错误' : '正确';
    case 'fill_blank': {
      const a = (n.answer || (n.acceptable_answers && n.acceptable_answers[0]) || '');
      return a ? ('✗' + a + '✗') : null; // 前缀标记经归一化仍在，必不等
    }
    case 'match': {
      const pairs = n.pairs || [];
      const rights = new Set(pairs.map(p => p.right));
      if (pairs.length >= 2 && rights.size === pairs.length) {
        // 右列错位：left[i] 配 right[(i+1)%n]（右列全异才保证错）
        return pairs.map((p, i) => `${p.left} = ${pairs[(i + 1) % pairs.length].right}`).join(', ');
      }
      return '左 = 右'; // 1 对或右列有重复 → 给垃圾串
    }
    case 'sort': {
      const order = (n.correct_order || []).map(id => (n.items || []).find(i => i.id === id)?.text).filter(Boolean);
      if (order.length >= 2) return [...order].reverse().join(' → ');
      return null;
    }
    case 'drag_drop': return (n.target_zone?.label || 'X') + '✗';
    case 'simulation_dial': {
      const wrong = (n.dial_options || []).find(o => !o.is_correct);
      return wrong ? wrong.label : null;
    }
    case 'simulation_danger': return '不安全操作';
    case 'simulation_probe': {
      if (!n.correct_probes) return null;
      if (n.allow_swap) return null; // allow_swap 时红黑对调判对，不适用
      return `红:${n.correct_probes.black}, 黑:${n.correct_probes.red}`;
    }
    case 'multimeter_challenge': return `档位:WRONG_DIAL, 红:X, 黑:Y`;
    default: return null;
  }
}
let graded = 0, negGraded = 0, bad = 0;
const actualCounts = {}; // basename -> total node count (incl. info)
console.log(`scan root: ${ROOT} (${files.length} files)`);
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  const base = path.basename(f);
  actualCounts[base] = 0;
  const nodeLists = [];
  if (Array.isArray(c)) nodeLists.push(c);            // top-level node array (exam pool)
  else {
    const ls = c.units ? c.units.flatMap(u => u.lessons || []) : (c.lessons || []);
    for (const l of ls) nodeLists.push(l.nodes || []);
  }
  for (const nodes of nodeLists) for (const n of nodes) {
    actualCounts[base]++;
    if (n.type === 'info') continue;
    if (n.type === 'simulation_dial') {
      // Angles must be present, in [0,360], and pairwise separated by ≥ MIN.
      const opts = n.dial_options || [];
      const angs = [];
      for (const [oi, o] of opts.entries()) {
        if (typeof o.angle !== 'number') { bad++; console.log('SIM-DIAL-NO-ANGLE', n.id, `opt[${oi}] label="${o.label}"`); continue; }
        if (o.angle < 0 || o.angle > 360) { bad++; console.log('SIM-DIAL-ANGLE-RANGE', n.id, o.angle, o.label); continue; }
        angs.push(o.angle);
      }
      angs.sort((a, b) => a - b);
      for (let i = 1; i < angs.length; i++) {
        const gap = angs[i] - angs[i - 1];
        if (gap < MIN_DIAL_ANGLE_GAP) { bad++; console.log('SIM-DIAL-ANGLE-GAP', n.id, `${angs[i - 1]}°→${angs[i]}° 仅 ${gap}° (< ${MIN_DIAL_ANGLE_GAP}°)`); }
      }
    }
    const ans = correctAnswer(n);
    if (ans === null || ans === undefined) { bad++; console.log('NO-ANSWER', n.id); continue; }
    let r;
    try { r = gradeNode(n, ans); } catch (e) { bad++; console.log('GRADE-ERR', n.id, e.message); continue; }
    graded++;
    if (!r.correct) { bad++; console.log('WRONG-GRADE', n.id, n.type, JSON.stringify(String(ans).slice(0, 60))); }
    // 错答负例（crosscheck5 X M9）：构造必错答案，判分若判对即宽容化回归
    const wrong = wrongAnswer(n);
    if (wrong !== null && wrong !== undefined) {
      let wr;
      try { wr = gradeNode(n, wrong); } catch (e) { bad++; console.log('WRONG-GRADE-ERR', n.id, e.message); continue; }
      negGraded++;
      if (wr.correct) { bad++; console.log('NEGATIVE-FAIL', n.id, n.type, `错答被判对: ${JSON.stringify(String(wrong).slice(0, 60))}`); }
    }
  }
}
// Per-file node-count canary.
for (const base of Object.keys(EXPECTED_NODE_COUNTS)) {
  const exp = EXPECTED_NODE_COUNTS[base];
  const act = actualCounts[base];
  if (act === undefined) { bad++; console.log('COUNT-MISSING-FILE', base, `未找到文件（或已改名）——预期 ${exp} 节点`); }
  else if (act !== exp) { bad++; console.log('COUNT-MISMATCH', base, `预期 ${exp} 节点, 实际 ${act}（有意重编请更新 EXPECTED_NODE_COUNTS）`); }
}
for (const base of Object.keys(actualCounts)) {
  if (EXPECTED_NODE_COUNTS[base] === undefined) { bad++; console.log('COUNT-UNLISTED-FILE', base, `实际 ${actualCounts[base]} 节点但未登记——请在 EXPECTED_NODE_COUNTS 补一行`); }
}
console.log('=== grading scan v2 ===');
console.log('graded nodes:', graded, '| negative-tested:', negGraded, '| non-100%:', bad);
if (bad > 0) {
  console.error(`❌ ${bad} node(s) fail — content/grading bug or a wrong-answer graded as correct (grading regression).`);
  process.exit(1);
}
console.log('✅ every gradeable node self-grades 100%, and all constructed wrong answers are rejected.');
