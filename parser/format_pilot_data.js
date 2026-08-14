const fs = require('fs');

const data1 = [
  {
    "type": "info",
    "content": "💡 欧姆定律的进阶注意事项：\n\n1. 适用条件：基础欧姆定律仅适用于**线性时不变电阻**，即它的阻值 R 必须为常数。\n2. 符号法则：当电压和电流的参考方向**非关联**时，欧姆定律必须加负号。脑补一张电路图：电阻左端标着电压正极 '+'，右端标着负极 '-'，但标示的电流箭头却从右端的 '-' 流入，向左穿过电阻。这种情况下，公式变为 **u = -iR**；若用电导 G 表示则为 **i = -Gu**。\n3. 元件特性：线性电阻是一种无记忆的双向性元件。"
  },
  {
    "type": "multiple_choice",
    "question": "小明在分析电路时遇到了非关联参考方向，他在图上画了一个电阻，标定电压 u 的正极在上方、负极在下方，而电流 i 的箭头却是从下往上（从负极流入）。此时小明应该用哪个公式来列方程？",
    "options": [
      "u = iR",
      "u = -iR",
      "i = Gu"
    ],
    "correct_answer": "u = -iR",
    "explanation": "当电流的参考方向从电压的负极流入时，这被称为“非关联参考方向”。在这种情况下，欧姆定律公式中必须引入一个负号，即 u = -iR。"
  },
  {
    "type": "multiple_choice",
    "question": "在大学的电路实验室里，小红拿到一个特殊的电阻器，她发现这个电阻的阻值不是固定的，而是随着时间在不断变化。同组的大强说：“不管它怎么变，咱们直接套用欧姆定律 u=iR 来计算瞬时电压就行！”大强的说法为什么是错误的？",
    "options": [
      "因为基础欧姆定律只适用于阻值为常数的线性时不变电阻",
      "因为特殊电阻不能用电阻 R 表示，必须用电导 G 表示",
      "因为随着时间变化的电阻属于有记忆元件，不遵守任何物理定律"
    ],
    "correct_answer": "因为基础欧姆定律只适用于阻值为常数的线性时不变电阻",
    "explanation": "石群教授强调过，基础的欧姆定律只适用于“线性时不变”的电阻，前提是阻值 R 为常数。如果阻值随时间变化，则不再是线性时不变元件。"
  }
];

const data2 = [
  {
    "type": "info",
    "title": "电阻的功率特性：永远的耗能元件",
    "content": "无论我们在图纸上如何假设参考方向，电阻的物理本质只有一个：它永远吸收功率、消耗能量（P吸 ≥ 0）。如果我们在解题时选用了非关联参考方向，欧姆定律必须加负号写成 U = -IR，此时用 P = UI 算出来的其实是“发出功率（P发）”。代入后得到 P发 = -I²R = -U²/R ≤ 0。负的发出功率，恰恰等于正的吸收功率。这也证明了，如果在实际电路中测量，电阻上的电压与电流实际方向绝对是关联的！"
  },
  {
    "type": "multiple_choice",
    "question": "某同学在分析电路时，对一个电阻使用了非关联参考方向进行列式，并用公式 P = UI 计算出了结果为 -15W。关于这个结果，下列说法正确的是？",
    "options": [
      "计算必然有误，因为电阻只会消耗能量，算出的功率必须是大于等于零的正数",
      "非关联方向下 P=UI 算的是吸收功率，负值说明该电阻在当前电路中起到了电源的作用",
      "非关联方向下 P=UI 算的是发出功率，-15W 的发出功率恰好说明电阻实际吸收了 15W 的功率",
      "非关联方向下欧姆定律是 U=IR，算出的 P=UI 为负，说明遇到了特殊的“负值电阻”"
    ],
    "correctIndex": 2,
    "explanation": "非关联参考方向下，公式 P = UI 计算的物理意义是“发出功率”。算出发出功率为 -15W（即 P发 ≤ 0），等价于吸收功率为 +15W（P吸 ≥ 0）。这完全符合电阻永远消耗能量的绝对特性，计算结果完全正确。"
  },
  {
    "type": "multiple_choice",
    "question": "小明深知“电阻实际中只吸收功率”，但他为了挑战自己，偏要在电路图中强行把一个常规电阻的电压和电流标成“非关联参考方向”。在这种情况下，该电阻的欧姆定律表达式及其实际吸收功率（P吸）的表达式应该是什么？",
    "options": [
      "U = -IR 且 P吸 = -I²R",
      "U = -IR 且 P吸 = I²R",
      "U = IR 且 P吸 = I²R",
      "U = -IR 且 P吸 = -U²/R"
    ],
    "correctIndex": 1,
    "explanation": "极具迷惑性的一题！既然图纸上标成了非关联方向，写欧姆定律时必须加上负号，即 U = -IR。但是，无论你怎么标箭头，电阻的物理本质不会变，它的吸收功率 P吸 永远是正的 I²R（或者 U²/R）。绝对不能因为欧姆定律带了负号，就把实际吸收功率也写成负数！"
  }
];

// 将提取到的数据转换成我们工程里的正式节点格式
let currentIdx = 0;
const formattedNodes = [];

[...data1, ...data2].forEach(node => {
  if (node.type === 'info') {
    formattedNodes.push({
      id: `l_test_n${currentIdx++}`,
      type: "info",
      title: node.title || "电路理论前沿解析",
      content: node.content
    });
  } else if (node.type === 'multiple_choice') {
    const opts = node.options.map((opt, i) => {
      let isCorrect = false;
      if (node.correct_answer) {
        isCorrect = opt === node.correct_answer;
      } else if (node.correctIndex !== undefined) {
        isCorrect = i === node.correctIndex;
      }
      return {
        id: String.fromCharCode(65 + i),
        text: opt,
        is_correct: isCorrect
      };
    });
    
    formattedNodes.push({
      id: `l_test_n${currentIdx++}`,
      type: "multiple_choice",
      question: node.question,
      options: opts,
      explanation: node.explanation
    });
  }
});

fs.writeFileSync('D:/dlg_project/parser/pilot_nodes.json', JSON.stringify(formattedNodes, null, 2));
console.log("Pilot nodes have been formatted successfully.");
