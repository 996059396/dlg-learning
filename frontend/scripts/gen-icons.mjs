// Generate PNG PWA icons (icon-192.png / icon-512.png) from the SVG source by
// rasterizing with headless Chrome (puppeteer is hoisted at the repo root).
// The SVG alone would install, but PNG icons are the widely-supported baseline
// (some browsers/OS launchers won't rasterize SVG manifest icons).
//
// Usage: run from repo root with the repo's node:
//   C:\Users\moxo\node24\node.exe frontend/scripts/gen-icons.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SVG_PATH = path.join(PUBLIC_DIR, 'icon.svg');

// Resolve the installed Chrome (mirror of e2e_helpers.resolveChrome).
function resolveChrome() {
  const candidates =
    process.platform === 'win32'
      ? [
          process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  const found = candidates.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error('未找到 Chrome/Chromium，无法栅格化图标');
  return found;
}

const svg = fs.readFileSync(SVG_PATH, 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const puppeteer = (await import('puppeteer')).default;
const browser = await puppeteer.launch({
  headless: true,
  executablePath: resolveChrome(),
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const page = await browser.newPage();
  for (const size of [192, 512]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.goto(dataUrl);
    // Wait for the emoji glyph to rasterize.
    await new Promise((r) => setTimeout(r, 300));
    const out = path.join(PUBLIC_DIR, `icon-${size}.png`);
    await page.screenshot({ path: out });
    console.log(`✓ icon-${size}.png (${fs.statSync(out).size} bytes)`);
  }
} finally {
  await browser.close();
}
