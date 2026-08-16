// 生成全部图标尺寸：favicon(16/32/48)、apple-touch(180)、PWA(192/512)、
// Electron(256 + Windows .ico)。源是 frontend/public/icon.svg（闪电+表盘设计），
// 用 headless Chrome 栅格化。ICO 用内嵌 PNG 方式（现代 Windows 支持）。
//
// 用法：用 Node 24 运行 node frontend/scripts/gen-icons.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SVG_PATH = path.join(PUBLIC_DIR, 'icon.svg');

function resolveChrome() {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  const candidates =
    process.platform === 'win32'
      ? [process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe', process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe', process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe', process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe']
      : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error('未找到 Chrome/Chromium，无法栅格化图标');
  return found;
}

// 内嵌 PNG 的 ICO（16/32/48/256）。宽度/高度字节 0 表示 256。
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(data);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const svg = fs.readFileSync(SVG_PATH, 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const puppeteer = (await import('puppeteer')).default;
const browser = await puppeteer.launch({
  headless: true,
  executablePath: resolveChrome(),
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const SIZES = [16, 32, 48, 180, 192, 256, 512];
const pngs = [];
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.goto(dataUrl);
    await new Promise((r) => setTimeout(r, 250));
    const out = path.join(PUBLIC_DIR, `icon-${size}.png`);
    await page.screenshot({ path: out });
    const data = fs.readFileSync(out);
    pngs.push({ size, data });
    console.log(`✓ icon-${size}.png (${data.length} bytes)`);
  }
} finally {
  await browser.close();
}

// favicon 用 16/32/48（浏览器 tab + 书签）
const ico = buildIco(pngs.filter((p) => [16, 32, 48, 256].includes(p.size)));
fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.ico'), ico);
console.log(`✓ favicon.ico (${ico.length} bytes)`);

// Electron 图标：electron-builder 用 .ico（win）或 512 png（mac/linux 会转）
fs.copyFileSync(path.join(PUBLIC_DIR, 'icon-512.png'), path.join(PUBLIC_DIR, 'icon-512.png'));
fs.copyFileSync(path.join(PUBLIC_DIR, 'favicon.ico'), path.join('D:/dlg_project/desktop', 'icon.ico'));
fs.copyFileSync(path.join(PUBLIC_DIR, 'icon-512.png'), path.join('D:/dlg_project/desktop', 'icon.png'));
console.log('✓ desktop/icon.ico + desktop/icon.png');
