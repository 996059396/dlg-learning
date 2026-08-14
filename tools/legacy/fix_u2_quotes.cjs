const fs = require('fs');
const path = require('path');
const __ROOT__ = path.resolve(__dirname, '..', '..');
const fp = path.join(__ROOT__, 'backend', 'data', 'courses', 'electrician_basics', 'u2_circuit_basics.json');

let txt = fs.readFileSync(fp, 'utf8');
const lines = txt.split('\n');
let fixed = 0;

const out = lines.map((line, idx) => {
  // Match: <whitespace>"<key>": "<value>"<optional comma>
  const m = line.match(/^(\s*"[a-zA-Z_]+"\s*:\s*")(.*)("[,}\]]?\s*)$/);
  if (m) {
    const prefix = m[1];
    let inner = m[2];
    const suffix = m[3];

    // Replace unescaped " in inner with \"
    // Walk through char by char: if char is " and prev is not \, escape it
    let result = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      const prev = i > 0 ? inner[i - 1] : '';
      if (c === '"' && prev !== '\\') {
        result += '\\"';
      } else {
        result += c;
      }
    }

    if (result !== inner) {
      fixed++;
      console.log('Line ' + (idx + 1) + ' fixed: ...' + inner.substring(0, 80) + '...');
      return prefix + result + suffix;
    }
  }
  return line;
});

if (fixed > 0) {
  fs.writeFileSync(fp, out.join('\n'));
  console.log('\n✅ Fixed ' + fixed + ' lines.');
}

try {
  JSON.parse(fs.readFileSync(fp, 'utf8'));
  console.log('✅ u2_circuit_basics.json is now valid JSON');
} catch (e) {
  console.log('❌ Still broken: ' + e.message);

  // Show problematic context
  const m = e.message.match(/position (\d+)/);
  if (m) {
    const pos = parseInt(m[1]);
    const data = fs.readFileSync(fp, 'utf8');
    console.log('Context near position ' + pos + ':');
    console.log(data.substring(Math.max(0, pos - 100), pos + 100));
  }
}
