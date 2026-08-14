const fs = require('fs');
const path = require('path');

const basePath = path.join(__dirname, 'backend', 'data', 'courses', 'electrician_basics');
const files = ['u2_circuit_basics.json', 'u3_tools.json', 'u4_relays.json'];

files.forEach(file => {
  const filePath = path.join(basePath, file);
  if (fs.existsSync(filePath)) {
    let data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.lessons.forEach(lesson => {
      lesson.nodes.forEach((node, idx) => {
        if (!node.id) {
          node.id = `${lesson.id}_n${idx}`;
        }
      });
    });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`✅ Appended IDs for ${file}`);
  }
});
