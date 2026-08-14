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
let graded = 0, bad = 0;
console.log(`scan root: ${ROOT} (${files.length} files)`);
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  const nodeLists = [];
  if (Array.isArray(c)) nodeLists.push(c);            // top-level node array (exam pool)
  else {
    const ls = c.units ? c.units.flatMap(u => u.lessons || []) : (c.lessons || []);
    for (const l of ls) nodeLists.push(l.nodes || []);
  }
  for (const nodes of nodeLists) for (const n of nodes) {
    if (n.type === 'info') continue;
    const ans = correctAnswer(n);
    if (ans === null || ans === undefined) { bad++; console.log('NO-ANSWER', n.id); continue; }
    let r;
    try { r = gradeNode(n, ans); } catch (e) { bad++; console.log('GRADE-ERR', n.id, e.message); continue; }
    graded++;
    if (!r.correct) { bad++; console.log('WRONG-GRADE', n.id, n.type, JSON.stringify(String(ans).slice(0, 60))); }
  }
}
console.log('=== grading scan v2 ===');
console.log('graded nodes:', graded, '| non-100%:', bad);
if (bad > 0) {
  console.error(`❌ ${bad} node(s) do not self-grade 100% — content/grading bug.`);
  process.exit(1);
}
console.log('✅ every gradeable node self-grades 100%.');
