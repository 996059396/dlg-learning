const fs = require('fs');
const path = require('path');

const dir = 'backend/data/courses/electrician_basics';
const files = ['u1_meter_basics.json', 'u2_circuit_basics.json', 'u3_tools.json', 'u4_relays.json', 'u5_multimeter_advanced.json'];

let md = '# DLG 电工课程题库完整导出\n\n';
let totalLessons = 0;
let totalNodes = 0;

files.forEach(f => {
  const fp = path.join(dir, f);
  if (!fs.existsSync(fp)) return;
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  
  md += `## 📚 ${data.title}\n`;
  md += `_${data.description}_\n\n`;

  data.lessons.forEach(l => {
    totalLessons++;
    md += `### 📖 ${l.title}\n`;
    
    l.nodes.forEach((n, idx) => {
      totalNodes++;
      md += `**[题型: ${n.type}]** `;
      if (n.title) md += `*${n.title}*\n`;
      else if (n.question) md += `*${n.question.replace(/\n/g, ' ')}*\n`;
      else md += '\n';

      if (n.content) md += `> ${n.content.replace(/\n/g, '\n> ')}\n`;
      if (n.instruction) md += `> 提示: ${n.instruction}\n`;

      // Options
      if (n.options) {
        n.options.forEach(o => {
          md += `  - [${o.is_correct ? 'x' : ' '}] ${o.text}\n`;
        });
      }
      
      // True/False
      if (n.type === 'true_false') {
        md += `  - 答案: **${n.correct_answer ? '正确' : '错误'}**\n`;
      }
      
      // Fill Blank
      if (n.type === 'fill_blank') {
        md += `  - 答案: **${n.answer || n.acceptable_answers?.join('/')}**\n`;
      }

      // Match
      if (n.type === 'match' && n.pairs) {
        n.pairs.forEach(p => md += `  - ${p.left}  ==>  ${p.right}\n`);
      }

      // Sort
      if (n.type === 'sort' && n.items) {
        md += `  - 正确顺序: ${n.correct_order?.map(id => n.items.find(i=>i.id===id)?.text).join(' → ')}\n`;
      }

      // Multimeter Challenge
      if (n.type === 'multimeter_challenge') {
        const cs = n.correct_setup || {};
        md += `  - 目标: ${n.target?.label}\n`;
        md += `  - 设置: 档位 [${cs.dial}], 红笔 [${cs.red_port}], 黑笔 [${cs.black_port}]\n`;
        md += `  - 探针: 红接 [${cs.red_touch}], 黑接 [${cs.black_touch}]\n`;
      }

      if (n.explanation) md += `\n  💡 解析: ${n.explanation}\n`;
      if (n.success_msg) md += `\n  ✅ 成功: ${n.success_msg}\n`;
      if (n.fail_msg) md += `\n  ❌ 失败: ${n.fail_msg}\n`;

      md += '\n---\n\n';
    });
  });
});

md += `\n**总计: ${files.length} 个单元, ${totalLessons} 节课, ${totalNodes} 个知识/测试节点。**\n`;

fs.writeFileSync('课程题库导出.md', md);
console.log('✅ Exported to D:/dlg_project/课程题库导出.md');
