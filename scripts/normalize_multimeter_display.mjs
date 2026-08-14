// Normalize multimeter reading-display fields across all course content:
//  - rename expected_display → correct_display (component reads correct_display)
//  - fix the physically-wrong values the audit flagged
// Run: node scripts/normalize_multimeter_display.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const __ROOT__ = path.resolve(__dirname, '..');
const COURSES_DIR = path.resolve(path.join(__ROOT__, 'backend', 'data', 'courses'));
const changed = [];
let renamed = 0;

function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (typeof node.expected_display === 'string') {
    // Prefer an explicit correct_display if present; else take the expected value.
    if (typeof node.correct_display !== 'string') {
      node.correct_display = node.expected_display;
      renamed++;
    }
    delete node.expected_display;
    changed.push(node.id || '(unnamed)');
  }
  for (const k of Object.keys(node)) walk(node[k]);
}

// Post-fix overrides for specific audited hard errors.
const OVERRIDES = {
  // 100µF on CAP_200U reads ~100µF, NOT 218µF (218 > 200 = overload). Also the
  // old fail_msg claimed "100µF > 200µF" — backwards math that taught 100<200 as OL.
  'l5_resistance_capacitor_n6': {
    correct_display: '100.5 μF',
    success_msg: '完美！100μF < 200μF，CAP_200UF 是最近上档；电解电容必须红笔接正极',
    fail_msg: '档位偏差：100μF < 200μF，应选 CAP_200UF（最近上档）。选 CAP_200N 或更小会 OL，选 CAP_2MF 精度变差',
  },
  // 24V on DCV_1000 reads "24 V" — drop the weird leading-zero "024 V".
  'l3_voltage_measure_n11': { correct_display: '24 V' },
};

// Unit files live in per-course subdirectories (e.g. .../courses/electrician_basics/u*.json).
const files = readdirSync(COURSES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .flatMap(dir => readdirSync(path.join(COURSES_DIR, dir.name))
    .filter(f => f.endsWith('.json') && !f.includes('_dump'))
    .map(f => path.join(COURSES_DIR, dir.name, f)));

for (const file of files) {
  const before = renamed;
  const json = JSON.parse(readFileSync(file, 'utf-8'));
  json.lessons?.forEach(lesson =>
    lesson.nodes?.forEach(node => {
      walk(node);
      const fix = OVERRIDES[node.id];
      if (fix) {
        for (const [k, v] of Object.entries(fix)) node[k] = v;
        changed.push(`${node.id} (override)`);
      }
    })
  );
  if (renamed > before) {
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf-8');
    console.log(`  ✏️ ${path.basename(file)}`);
  }
}

console.log(`\nRenamed ${renamed} display fields; overrides applied; touched nodes:`);
console.log([...new Set(changed)].join(', '));
