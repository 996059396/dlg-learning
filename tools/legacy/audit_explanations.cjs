// Audit explanations across 5 unit JSONs
// Counts questions with `explanation` only vs those with success_msg + fail_msg

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'backend', 'data', 'courses', 'electrician_basics');
const FILES = [
  'u1_meter_basics.json',
  'u2_circuit_basics.json',
  'u3_tools.json',
  'u4_relays.json',
  'u5_multimeter_advanced.json',
];

const QUESTION_TYPES = new Set([
  'multiple_choice',
  'true_false',
  'fill_blank',
  'sort',
  'match',
  'drag_drop',
]);

// Recursively walk JSON tree, collecting all question nodes
function collectQuestions(obj, out) {
  if (Array.isArray(obj)) {
    for (const item of obj) collectQuestions(item, out);
    return;
  }
  if (obj && typeof obj === 'object') {
    if (typeof obj.type === 'string' && QUESTION_TYPES.has(obj.type)) {
      out.push(obj);
    }
    for (const key of Object.keys(obj)) {
      collectQuestions(obj[key], out);
    }
  }
}

const grandTotals = {
  withExplanationField: 0,
  onlyExplanation: 0,        // has explanation, missing both success_msg and fail_msg
  hasBothSuccessFail: 0,     // has success_msg AND fail_msg
  partial: 0,                // has one of success_msg/fail_msg but not both
  noFeedbackAtAll: 0,        // none of the three fields
  byType: {},
};

const perFile = [];
const onlyExplanationSamples = [];

for (const file of FILES) {
  const full = path.join(DIR, file);
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const qs = [];
  collectQuestions(raw, qs);

  const stat = {
    file,
    totalQuestions: qs.length,
    withExplanationField: 0,
    onlyExplanation: 0,
    hasBothSuccessFail: 0,
    partial: 0,
    noFeedbackAtAll: 0,
    byType: {},
  };

  for (const q of qs) {
    const hasExp = typeof q.explanation === 'string' && q.explanation.length > 0;
    const hasSucc = typeof q.success_msg === 'string' && q.success_msg.length > 0;
    const hasFail = typeof q.fail_msg === 'string' && q.fail_msg.length > 0;

    const typeKey = q.type;
    stat.byType[typeKey] = stat.byType[typeKey] || { total: 0, only: 0, both: 0 };
    stat.byType[typeKey].total += 1;
    grandTotals.byType[typeKey] = grandTotals.byType[typeKey] || { total: 0, only: 0, both: 0 };
    grandTotals.byType[typeKey].total += 1;

    if (hasExp) {
      stat.withExplanationField += 1;
      grandTotals.withExplanationField += 1;
    }

    if (hasSucc && hasFail) {
      stat.hasBothSuccessFail += 1;
      grandTotals.hasBothSuccessFail += 1;
      stat.byType[typeKey].both += 1;
      grandTotals.byType[typeKey].both += 1;
    } else if (hasExp && !hasSucc && !hasFail) {
      stat.onlyExplanation += 1;
      grandTotals.onlyExplanation += 1;
      stat.byType[typeKey].only += 1;
      grandTotals.byType[typeKey].only += 1;
      if (onlyExplanationSamples.length < 20) {
        onlyExplanationSamples.push({
          file,
          id: q.id,
          type: q.type,
          question: q.question || q.title || '(no text)',
          explanation: q.explanation,
        });
      }
    } else if (hasSucc || hasFail) {
      stat.partial += 1;
      grandTotals.partial += 1;
    } else if (!hasExp) {
      stat.noFeedbackAtAll += 1;
      grandTotals.noFeedbackAtAll += 1;
    }
  }

  perFile.push(stat);
}

// Print
console.log('='.repeat(72));
console.log('EXPLANATION AUDIT — electrician_basics (5 units)');
console.log('='.repeat(72));

for (const s of perFile) {
  console.log(`\n[${s.file}]`);
  console.log(`  题目总数(6 种题型):            ${s.totalQuestions}`);
  console.log(`  含 explanation 字段:           ${s.withExplanationField}`);
  console.log(`  仅 explanation (无对错分支):   ${s.onlyExplanation}`);
  console.log(`  含 success_msg + fail_msg:     ${s.hasBothSuccessFail}`);
  console.log(`  只有 success 或 fail 之一:     ${s.partial}`);
  console.log(`  三个字段都没有:                ${s.noFeedbackAtAll}`);
  console.log(`  分题型:`);
  for (const t of Object.keys(s.byType)) {
    const x = s.byType[t];
    console.log(`    - ${t.padEnd(16)} total=${x.total}  仅explanation=${x.only}  both=${x.both}`);
  }
}

console.log('\n' + '='.repeat(72));
console.log('全部 5 个文件汇总');
console.log('='.repeat(72));
console.log(`含 explanation 字段总数:        ${grandTotals.withExplanationField}`);
console.log(`仅 explanation (无对错分支):    ${grandTotals.onlyExplanation}`);
console.log(`含 success_msg + fail_msg:      ${grandTotals.hasBothSuccessFail}`);
console.log(`只有 success 或 fail 之一:      ${grandTotals.partial}`);
console.log(`三个字段都没有:                 ${grandTotals.noFeedbackAtAll}`);
console.log('\n分题型汇总:');
for (const t of Object.keys(grandTotals.byType)) {
  const x = grandTotals.byType[t];
  console.log(`  - ${t.padEnd(16)} total=${x.total}  仅explanation=${x.only}  both=${x.both}`);
}

console.log('\n' + '='.repeat(72));
console.log('随机抽样 5 道「仅 explanation」题目');
console.log('='.repeat(72));
const picks = [];
const step = Math.max(1, Math.floor(onlyExplanationSamples.length / 5));
for (let i = 0; i < onlyExplanationSamples.length && picks.length < 5; i += step) {
  picks.push(onlyExplanationSamples[i]);
}
for (const p of picks) {
  console.log(`\n[${p.file} / ${p.id}] type=${p.type}`);
  console.log(`  Q: ${p.question}`);
  console.log(`  explanation: ${p.explanation}`);
}
