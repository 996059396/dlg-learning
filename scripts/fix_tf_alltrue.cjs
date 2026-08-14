#!/usr/bin/env node
// C10: TF all-true bias (exam s12/s13) — convert select true/false nodes to
// plausible FALSE statements anchored in each lesson's own verified content.
// Guessing "正确" for every TF no longer yields 100%. Each new statement is a
// common misconception; the explanation states the correct fact.
const fs = require('fs');
const path = require('path');

const CONVERSIONS = [
  {
    match: '抽屉式单元的三个位置是连接、试验、抽出，主电路在试验位置时已断开。',
    question: '抽屉式单元的三个位置是连接、试验、抽出，在试验位置时主电路和二次回路均保持接通，以便带电试运行。',
    explanation: '不对。试验位置主电路已断开、二次回路可通电试运行；连接位置主二次全通；抽出位置主二次全断可抽出检修。若试验位置主二次都接通，就无法安全带电试二次了。',
  },
  {
    match: '母线连接处螺栓要按规定力矩紧固并加弹簧垫圈，防止运行松动发热。',
    question: '母线连接处螺栓拧得越紧越好，不必按力矩控制，也不必加弹簧垫圈。',
    explanation: '不对。螺栓过紧会压伤母排和接线端子，过松则接触电阻增大、运行发热；必须按规定力矩紧固并加弹簧垫圈防振松，才能保证接触可靠。',
  },
  {
    match: '低压断路器安装应垂直安装、上进下出，接线端子压接牢固。',
    question: '低压断路器安装方向不限，横装倒装都可以，进出线上下均可，不影响脱扣动作。',
    explanation: '不对。断路器必须垂直安装，保证脱扣机构可靠动作；横装/倒装会卡涩脱扣机构，导致故障时拒动。进出线也应上进下出、端子压接牢固。',
  },
  {
    match: '心肺复苏按压与吹气比例为 30:2，按压频率 100-120 次/分。',
    question: '成人心肺复苏的按压与吹气比例为 15:2，按压频率 60-80 次/分。',
    explanation: '不对。成人 CPR 标准是按压:吹气 = 30:2，按压频率 100-120 次/分、深度 5-6cm。15:2 和 60-80 次/分都是错误参数，按压过慢会失去泵血效果。',
  },
  {
    match: '用万用表测电阻时，带电测量会损坏万用表，应断电并让电阻一端脱离电路。',
    question: '用万用表测电阻可以在线直接测量，不必断电，读数一样准确。',
    explanation: '不对。带电测电阻时被测电压产生的电流会流过表头而烧毁万用表，且并联支路会使读数偏小；必须断电、让被测电阻一端脱离电路、先欧姆调零再测。',
  },
  {
    match: '自锁控制用接触器常开辅助触点并联启动按钮，使接触器在按钮松开后保持吸合。',
    question: '自锁控制是把接触器常闭辅助触点串联进控制回路，实现按钮松开后保持吸合。',
    explanation: '不对。自锁必须用常开辅助触点与启动按钮并联：按下启动按钮→线圈吸合→常开辅助触点闭合→松开按钮后仍经辅助触点自供电保持吸合。若把常闭触点串联进回路，一吸合就把线圈断电了。',
  },
  {
    match: '继电保护的基本要求是可靠、选择、快速、灵敏「四性」。',
    question: '继电保护的基本要求是灵敏、可靠、经济、简单「四性」。',
    explanation: '不对。继保四性是可靠（不误动不拒动）、选择（只切故障区）、快速（缩短故障时间）、灵敏（对故障响应）；「经济、简单」是设计时的次要考虑，不是四性内容。',
  },
];

const file = path.join(__dirname, '..', 'backend', 'data', 'courses', 'electrician_exam', 's12_lv_switchgear.json');
const file13 = path.join(__dirname, '..', 'backend', 'data', 'courses', 'electrician_exam', 's13_mock_exam.json');

let done = 0, errors = 0;
for (const [f, label] of [[file, 's12'], [file13, 's13']]) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  const lessons = c.units ? c.units.flatMap(u => u.lessons || []) : (c.lessons || []);
  for (const conv of CONVERSIONS) {
    let hits = 0;
    for (const l of lessons) for (const n of l.nodes || []) {
      if (n.type === 'true_false' && n.question === conv.match) {
        hits++;
        if (n.correct_answer !== true) {
          console.log(`SKIP ${n.id}: already false`); errors++;
          continue;
        }
        n.question = conv.question;
        n.correct_answer = false;
        n.explanation = conv.explanation;
        console.log(`converted ${n.id} -> FALSE`);
        done++;
      }
    }
    if (hits === 0) { console.log(`NO MATCH: ${conv.match.slice(0, 30)}…`); errors++; }
    if (hits > 1) { console.log(`MULTI MATCH (${hits}): ${conv.match.slice(0, 30)}…`); errors++; }
  }
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n', 'utf8');
}
console.log(`\nconverted ${done}, errors ${errors}`);
