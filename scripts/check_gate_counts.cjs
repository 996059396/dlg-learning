#!/usr/bin/env node
// 门禁计数自检（crosscheck6 P high）：跑各计数产出脚本，解析「N passed」，与 manifest
// 比对——任何断言数/节点数/课时数漂移立即失败并打印正确值（根治 4,991 vs 5,020 那类
// 文档漂移反复发生）。用法：node scripts/check_gate_counts.cjs（仓库根，Node 24）。
// CI：在 npm test 后追加本脚本，防止「门禁全绿但文档数字过时」。
const path = require('path');
const { spawnSync } = require('child_process');

const NODE = process.env.DLG_NODE24 || process.execPath;
const ROOT = path.resolve(__dirname, '..');
// 当前权威计数（改断言数时同步更新这里；脚本会在漂移时打印实际值）。
const MANIFEST = {
  'validate_content.cjs': { pat: /(\d+) 节点/, expect: 5029 },
  'test_api.mjs': { pat: /(\d+) passed/, expect: 47 },
  'smoke_milestone1.mjs': { pat: /(\d+) passed/, expect: 20 },
  'test_leaderboard_v2.mjs': { pat: /(\d+) PASS/, expect: 13 },
  'smoke_settlement.mjs': { pat: /(\d+) passed/, expect: 14 },
  'test_security_invariants.mjs': { pat: /(\d+) passed/, expect: 19 },
  'test_idempotency.mjs': { pat: /（(\d+) 断言/, expect: 17 },
  'grade_scan.cjs': { pat: /graded nodes: (\d+)/, expect: 3748 },
  'check_data_integrity.cjs': { pat: /\((\d+) lessons/, expect: 706 },
};

let failed = 0;
const results = {};
for (const [file, { pat, expect }] of Object.entries(MANIFEST)) {
  const script = file.startsWith('scripts/') ? file : `scripts/${file}`;
  const isScript = file.endsWith('.cjs');
  const r = spawnSync(NODE, [isScript ? path.join(ROOT, script) : path.join(ROOT, file)], {
    cwd: path.join(ROOT, 'backend'), encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(pat);
  const actual = m ? parseInt(m[1], 10) : -1;
  results[file] = actual;
  if (actual !== expect) {
    failed++;
    console.error(`❌ ${file}: 预期 ${expect}，实际 ${actual === -1 ? '(未匹配)' : actual}`);
  } else {
    console.log(`✅ ${file}: ${actual}`);
  }
}
const total = results['test_api.mjs'] + results['smoke_milestone1.mjs'] + results['test_leaderboard_v2.mjs'] +
  results['smoke_settlement.mjs'] + results['test_security_invariants.mjs'] + results['test_idempotency.mjs'];
console.log(`总断言：${total}${total === 130 ? ' ✅' : '（漂移，需同步 docs 129→' + total + '）'}`);
if (total !== 130) failed++;
if (failed) { console.error(`❌ 门禁计数漂移 ${failed} 处——按上面「实际」值同步 8 份文档与 MANIFEST。`); process.exit(1); }
console.log('✅ 门禁计数自检通过（文档数字 = 实测数字）。');
