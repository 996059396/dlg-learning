#!/usr/bin/env node
// C9: strip video-transcription meta-commentary from teaching content.
// These notes ("转录中常被误写成「电脑」", "转录里的 kvl/kpl 都是 KVL 的误写"…)
// leak the source video's transcription process into learner-facing cards.
// The technical facts stay; only the meta-commentary goes.
const fs = require('fs');
const path = require('path');

const COURSES_DIR = path.join(__dirname, '..', 'backend', 'data', 'courses');
if (!fs.existsSync(COURSES_DIR)) { console.error('courses dir not found:', COURSES_DIR); process.exit(1); }

function walk(dir) {
  let out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) out = out.concat(walk(p));
    else if (/\.json$/.test(f) && f !== 'index.json') out.push(p);
  }
  return out;
}

// ── exact replacements: [transcription-meta, replacement] ──
// Factual tail kept where it carries real content (G=1/R, I²R formula, etc.).
const REPLACEMENTS = [
  ['G = 1/R 称为电导（转录中常被误写成「电脑」）', 'G = 1/R 称为电导'],
  ['G 是电导（电阻的倒数）——转录中\'电脑\'多为\'电导\'之误', 'G 是电导（电阻的倒数）'],
  ["进入电路元件之前先立一个贯穿全书的前提概念——集总参数电路（转录中'几种参数'均应为'集总参数'）",
   '进入电路元件之前先立一个贯穿全书的前提概念——集总参数电路'],
  ["i²R 就是焦耳定律的瞬时功率，转录里常被听成'iPhone 2'的正是 I²R", 'i²R 就是焦耳定律的瞬时功率'],
  ['注意语音转录常把『模匹配』写成『磨匹配/魔匹配』，规范术语是模匹配', ''],
  ['注意转录里"电脑"其实是"电导"的误识别，电导G=1/R', '电导G=1/R'],
  ['转录里的「电脑」其实是「电导」', ''],
  ['转录里的 kvl/kpl 都是 KVL 的误写，注意分辨', ''],
  ['注意『电导』常被转录成『电脑』，G=1/R', 'G=1/R'],
  ['转录里常把『电导』误写成『电脑』，看讲义时注意', ''],
  ['转录里 P发常被写成『批发』、P吸写成『pc』，注意辨认', ''],
  ['转录里 I²R 常被写成『iphone 2』，看讲义时会心一笑即可', ''],
  ['转录里的『iphone 2』其实就是 I²R 的谐音', ''],
  ["注意转录里的'电脑'其实是'电导'——听课时要自动纠错", ''],
  ['转录中的「iphone 2」就是 I²R——电流平方乘电阻的功率公式，其中 I=Uoc/(Req+RL)',
   'I²R——电流平方乘电阻的功率公式，其中 I=Uoc/(Req+RL)'],
  ['P=i²R（转录里的「iphone 2」即 I²R）', 'P=i²R'],
  ['转录里的「电脑」都是「电导」的误写', ''],
  ['转录中的「歪型」是「Y型」的误写', ''],
  ['转录中 KVL 常被写成『kv l』', ''],
  ['转录中的「ksl」「k cl」都是 KCL', ''],
  ['转录中的「kv l」就是 KVL', ''],
  ['注意转录中「电脑」常是「电导」', ''],
  ['转录中「组织」多为「阻值」、「电脑」为「电导」', ''],
];

// ── question node built entirely on transcription trivia → real content ──
const QUESTION_REWRITE = {
  'u9_theorems_l15_p1_n4': '电导 G 是电阻 R 的倒数，单位是西门子（S），对吗？',
};

// ── garbage acceptable_answers from transcription ──
const ACCEPTABLE_PRUNES = {
  'u10_opamp_dynamics_l71_p1_n6': ['1米系统'],
  'p05_battery_box_n4': ['负级'],
};

function lessonsOf(c) {
  return c.units ? c.units.flatMap(u => u.lessons || []) : (c.lessons || []);
}

function collapsePunct(s) {
  let out = s;
  let prev = null;
  while (prev !== out) { prev = out; out = out.replace(/。。+/g, '。').replace(/；；+/g, '；'); }
  return out;
}

let totalApplied = 0;
const changed = [];

for (const file of walk(COURSES_DIR)) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  let dirty = false;

  for (const l of lessonsOf(c)) {
    for (const n of l.nodes || []) {
      // Teach fields
      for (const field of ['question', 'content', 'explanation']) {
        if (typeof n[field] !== 'string') continue;
        let s = n[field];
        for (const [oldStr, newStr] of REPLACEMENTS) {
          if (s.includes(oldStr)) {
            s = s.split(oldStr).join(newStr);
            totalApplied++;
            dirty = true;
          }
        }
        if (field === 'question' && QUESTION_REWRITE[n.id] && s !== QUESTION_REWRITE[n.id]) {
          s = QUESTION_REWRITE[n.id];
          totalApplied++;
          dirty = true;
        }
        const cleaned = collapsePunct(s);
        if (cleaned !== n[field]) { n[field] = cleaned; dirty = true; }
        else if (s !== n[field]) { n[field] = s; dirty = true; }
      }

      // acceptable_answers prune
      if (Array.isArray(n.acceptable_answers)) {
        const pruneKey = ACCEPTABLE_PRUNES[n.id];
        if (pruneKey) {
          const before = n.acceptable_answers.length;
          n.acceptable_answers = n.acceptable_answers.filter(a => !pruneKey.includes(a));
          if (n.acceptable_answers.length !== before) {
            totalApplied += before - n.acceptable_answers.length;
            dirty = true;
          }
        }
      }
    }
  }

  if (dirty) {
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n', 'utf8');
    changed.push(file);
  }
}

console.log(`replacements applied: ${totalApplied}`);
console.log(`files changed (${changed.length}):`);
for (const f of changed) console.log('  ' + f.replace(/\\/g, '/').replace(COURSES_DIR, '.'));

// sanity: no 转录 should remain in teach fields
let residual = 0;
for (const file of walk(COURSES_DIR)) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const l of lessonsOf(c)) for (const n of l.nodes || []) {
    for (const field of ['question', 'content', 'explanation']) {
      if (typeof n[field] === 'string' && n[field].includes('转录')) residual++;
    }
    if (Array.isArray(n.options)) for (const o of n.options) {
      if (typeof o.text === 'string' && o.text.includes('转录')) residual++;
    }
  }
}
console.log(`residual 转录 occurrences in teach/option fields: ${residual}`);
