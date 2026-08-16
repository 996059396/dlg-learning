// Shared helpers for the browser e2e scripts (test_browser / test_leaderboard_e2e
// / test_multimeter_e2e). Fixes the crosscheck4 X08 findings in one place:
//  - the app gate's identity (dlg_token) is injected before any navigation —
//    the three scripts used to goto business URLs with no token and only ever
//    saw the AuthScreen;
//  - headless is the default (was headless:false in test_multimeter_e2e, which
//    fails on a display-less CI runner);
//  - the hardcoded Windows Chrome path is now env-overridable (BROWSER_PATH)
//    with per-OS detection so the matrix runs on macOS/Linux;
//  - a backend/frontend are started on demand so the scripts are self-contained.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';

export const BACK = 'http://localhost:3001';
export const FRONT = 'http://localhost:5173';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Chrome discovery ─────────────────────────────────────────────────────────
// BROWSER_PATH env wins; otherwise probe per-platform known locations.
export function resolveChrome() {
  if (process.env.BROWSER_PATH) {
    const p = process.env.BROWSER_PATH;
    if (!fs.existsSync(p)) throw new Error(`BROWSER_PATH 不存在: ${p}`);
    return p;
  }
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
  const found = candidates.find(c => c && fs.existsSync(c));
  if (!found) throw new Error('未找到 Chrome/Chromium，请设置 BROWSER_PATH 环境变量');
  return found;
}

// ── Launch ───────────────────────────────────────────────────────────────────
export async function launch(opts = {}) {
  const chrome = resolveChrome();
  return (await puppeteer()).launch({
    headless: opts.headless ?? true,           // X08: default headless for CI
    executablePath: chrome,
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=420,900'],
    ...opts.launchOverrides,
  });
}

// puppeteer is hoisted at the repo root (no root package.json, plain node_modules)
function puppeteer() {
  return import('puppeteer').then(mod => mod.default || mod);
}

// ── Auth: register a throwaway user, inject its token into the page ─────────
// The App gate renders only AuthScreen until a valid dlg_token exists. These
// e2e flows must be authenticated, so we register a fresh user per run and
// inject the token before any navigation (evaluateOnNewDocument runs on every
// frame/ navigation before page scripts).
export async function registerUser() {
  const uname = `e2e_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: uname, password: 'testpass123' });
    const req = http.request(
      { host: '127.0.0.1', port: 3001, path: '/api/auth/register', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          // 429（register 桶 5/15min/IP）必须显式失败——静默注入 undefined token
          // 会让后续用例在 AuthScreen 下全 FAIL 且报错极具误导性（crosscheck5 C3）。
          if (res.statusCode === 429) {
            reject(new Error(`注册被限流(429): 多套 e2e 连跑触发了 register 桶。等 15 分钟或起一个带 DLG_RATE_MAX_register 的自启后端（ensureBackend）。`));
            return;
          }
          try { resolve({ username: uname, ...JSON.parse(data) }); }
          catch (e) { reject(new Error('注册失败: ' + data)); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function injectAuth(page, token) {
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('dlg_token', t); } catch (e) {}
  }, token);
}

// Also pre-unlock prerequisite lessons (courses gate first-run locked units).
export async function injectProgress(page, progressObj) {
  await page.evaluateOnNewDocument((j) => {
    try { localStorage.setItem('dlg_progress', j); } catch (e) {}
  }, JSON.stringify(progressObj));
}

// ── On-demand servers (self-contained scripts) ───────────────────────────────
// 可移植（crosscheck5 X7）：默认用当前解释器（node24 跑脚本即 node24），勿硬编码本机路径
const NODE24 = process.env.DLG_NODE24 || process.execPath;

export function portOpen(port) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 500 }, res => { res.destroy(); resolve(true); });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.end();
  });
}

// Port open ≠ API ready: a freshly spawned backend runs its SQLite migrations
// (leaderboard rebuild etc.) before the routers serve. Hitting it in that
// window produced transient 401/5xx cascades on e2e runs. /api/health is
// mounted after every router, so a 200 means the full stack is serving.
function healthOk(port) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 1000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.end();
  });
}

export async function ensureBackend() {
  if (await healthOk(3001)) return null;
  console.log('· 后端未就绪，启动 backend/server.js …');
  // DLG_RATE_MAX_<scope> is the designed test-suite escape hatch (see
  // middleware/rate_limit.js): this suite registers a fresh throwaway user per
  // run, and the prod register bucket (5/15min/IP) would 429 mid-suite when
  // scripts run back-to-back — which surfaced as intermittent auth 401s. Prod
  // never sets these vars. login-user per-account stays at prod limits so the
  // lockout tests remain meaningful.
  const child = spawn(NODE24, [path.join('backend', 'server.js')], {
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, DLG_RATE_MAX_register: '500' },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await healthOk(3001)) return child;
    await sleep(500);
  }
  throw new Error('后端 30s 内未就绪');
}

export async function ensureFrontend() {
  if (await portOpen(5173)) return null;
  console.log('· 前端 dev server 未运行，启动 vite …');
  const child = spawn(NODE24, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: path.join(process.cwd(), 'frontend'),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await portOpen(5173)) return child;
    await sleep(500);
  }
  throw new Error('前端 30s 内未就绪');
}
