const fs = require('fs');
const path = require('path');

const RAW_DIR = 'D:/dlg_project';
const PARSER_DIR = 'D:/dlg_project/parser';
const OUT_DIR = path.join(PARSER_DIR, 'chunks');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function cleanAndChunkSubtitle(filename) {
  const filepath = path.join(RAW_DIR, filename);
  if (!fs.existsSync(filepath)) return;

  console.log(`\nProcessing: ${filename}`);
  const text = fs.readFileSync(filepath, 'utf8');

  // 1. Clean timestamps and metadata
  // Remove lines like "[00:00:19,699] " or empty lines
  const lines = text.split('\n')
    .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2},\d{3}\]\s*/, '').trim())
    .filter(l => l.length > 0 && !l.startsWith('字幕by'));

  // 2. Identify semantic anchors and chunk
  const chunks = [];
  let currentChunk = [];
  let currentTitle = 'Introduction';

  // Anchor patterns
  const chapterPattern = /(第[一二三四五六七八九十]+[章|节]|下面.*讲|开始.*第)/;
  const examplePattern = /(看.*例题|例[一二三四五]|注意.*问题|重点.*是)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if line is a semantic boundary
    if (chapterPattern.test(line) || examplePattern.test(line)) {
      if (currentChunk.length > 5) { // Ensure chunk isn't too tiny
        chunks.push({ title: currentTitle, lines: currentChunk });
        // Sliding window: keep last 3 lines for context continuity
        currentChunk = currentChunk.slice(-3);
      }
      currentTitle = line.substring(0, 30); // Use boundary text as chunk title hint
    }

    currentChunk.push(line);

    // Hard limit fallback: if a chunk gets too large (e.g. > 150 lines), split it
    if (currentChunk.length > 150) {
      chunks.push({ title: currentTitle + ' (Part 2)', lines: currentChunk });
      currentChunk = currentChunk.slice(-3);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({ title: currentTitle, lines: currentChunk });
  }

  // 3. Save chunks
  const baseName = filename.replace('.txt', '');
  chunks.forEach((c, idx) => {
    const outName = `${baseName}_chunk_${String(idx+1).padStart(3, '0')}.txt`;
    // Join lines into a paragraph. The LLM will handle the raw flow better without hard line breaks
    fs.writeFileSync(path.join(OUT_DIR, outName), `Title Hint: ${c.title}\n\n` + c.lines.join('，'));
  });

  console.log(`✅ Created ${chunks.length} chunks for ${filename}`);
}

const targetFiles = [
  "shiqun_09_new.txt",
  "shiqun_10_new.txt",
  "shiqun_11_new.txt",
  "shiqun_12_new.txt",
  "shiqun_13_new.txt",
  "shiqun_14_new.txt",
  "shiqun_15_new.txt",
  "shiqun_16_new.txt",
  "shiqun_17_new.txt",
  "shiqun_18_new.txt",
  "shiqun_19_new.txt",
  "shiqun_20_new.txt",
  "shiqun_21_new.txt",
  "shiqun_22_new.txt",
  "shiqun_23_new.txt",
  "shiqun_24_new.txt",
  "shiqun_25_new.txt",
  "shiqun_26_new.txt",
  "shiqun_27_new.txt",
  "shiqun_28_new.txt",
  "shiqun_29_new.txt",
  "shiqun_30_new.txt",
  "shiqun_31_new.txt",
  "shiqun_32_new.txt",
  "shiqun_33_new.txt",
  "shiqun_34_new.txt",
  "shiqun_35_new.txt",
  "shiqun_36_new.txt",
  "shiqun_37_new.txt",
  "shiqun_38_new.txt",
  "shiqun_39_new.txt",
  "shiqun_40_new.txt",
  "shiqun_41_new.txt"
];

targetFiles.forEach(cleanAndChunkSubtitle);
