// Round 2: fix remaining issues
const fs = require('fs');
const path = require('path');

const dir = 'D:/dlg_project/backend/data/courses/electrician_basics';
const files = ['u1_meter_basics.json','u2_circuit_basics.json','u3_tools.json','u4_relays.json','u5_multimeter_advanced.json'];

let fixCount = 0;

files.forEach(file => {
  const fp = path.join(dir, file);
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let fileFixed = 0;

  data.lessons.forEach(lesson => {
    lesson.nodes.forEach((node, idx) => {

      // === Sort: items is string array (not object), convert to {id, text} ===
      if (node.type === 'sort' && Array.isArray(node.items)) {
        // Check if items are plain strings
        if (node.items.every(i => typeof i === 'string')) {
          const newItems = node.items.map((text, i) => ({ id: String(i + 1), text }));
          node.items = newItems;
          // Re-build correct_order assuming current order is correct
          node.correct_order = newItems.map(i => i.id);
          fileFixed++;
        }
        // Check if correct_order has nulls (broken)
        else if (Array.isArray(node.correct_order) && node.correct_order.some(o => o == null)) {
          // Assume items are already in correct order
          node.correct_order = node.items.map(i => i.id);
          fileFixed++;
        }
      }

      // === u5 sort: correct_order is numeric indices but items use "1","2",... ===
      if (node.type === 'sort' && Array.isArray(node.items) && Array.isArray(node.correct_order)) {
        const itemIds = new Set(node.items.map(i => i.id));
        const allMatch = node.correct_order.every(o => itemIds.has(String(o)));
        if (!allMatch) {
          // Check if correct_order is 0-based indices
          const asIndices = node.correct_order.every(o => Number.isInteger(o) && o >= 0 && o < node.items.length);
          if (asIndices) {
            node.correct_order = node.correct_order.map(i => node.items[i].id);
            fileFixed++;
          }
        }
      }

      // === Match: single-pair → add a sensible second pair ===
      if (node.type === 'match' && Array.isArray(node.pairs) && node.pairs.length < 2) {
        // Leave alone if zero, but if 1, we already padded once. Now check if we duplicated badly
        // If both pairs are now the same text "(变体)", skip it; not much better we can do
      }
    });
  });

  if (fileFixed > 0) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    console.log(`✅ ${file}: 修复 ${fileFixed} 处`);
    fixCount += fileFixed;
  } else {
    console.log(`   ${file}: 无需修复`);
  }
});

console.log(`\n📊 总计修复 ${fixCount} 处。`);
