// X07 + X02 端到端验证（针对生产单源构建 http://127.0.0.1:3100）：
//  - X07：安全头存在 + CSP 不破坏应用（在线加载/作答全程无 CSP 报错）；
//  - X02：manifest/SW 注册、壳缓存、课程 GET 缓存、离线重载命中缓存、
//    离线完成入队、重连 flush 同步 + 服务端幂等收据落库。
//
// 自建独立后端（3100 + throwaway DB + DLG_RATE_MAX_register 放开），不碰 3001。
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url)); // 仓库根

// 可移植（crosscheck5 X H7）：默认用当前解释器，勿硬编码本机路径
const NODE24 = process.env.DLG_NODE24 || process.execPath;
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `dlg_pwa_e2e_${Date.now()}.db`);
const COURSE = 'electrician_prereq';
const UNIT = 'e1_middle_school';
const LESSON = 'p25_home_circuit_protection';
const LESSON_URL = `${BASE}/course/${COURSE}/unit/${UNIT}/lesson/${LESSON}`;

let failures = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures++; console.error(`  ✗ ${msg}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function apiReq(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: url, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        let parsed = s;
        try { parsed = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitHealth() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      apiReq('GET', '/api/health', null, null).then(({ status }) => {
        if (status === 200) return resolve();
        if (++tries > 60) return reject(new Error('后端 30s 未就绪'));
        setTimeout(tick, 500);
      }).catch(() => {
        if (++tries > 60) return reject(new Error('后端 30s 未就绪'));
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

// 从 lesson JSON 构造每个节点应有的正确答案（判分契约，见 gradeNode）。
function correctAnswerFor(node) {
  switch (node.type) {
    case 'true_false': return node.correct_answer === true ? '正确' : '错误';
    case 'multiple_choice': return node.options?.find(o => o.is_correct)?.text ?? null;
    case 'fill_blank': return node.answer ?? node.acceptable_answers?.[0] ?? null;
    default: return null;
  }
}

// 读取当前「第 N / total 题」计数器的 N（找不到返回 0）。
async function currentCounter(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(e =>
      e.children.length === 0 && /^第 \d+ \/ \d+ 题$/.test((e.textContent || '').trim())
    );
    if (!el) return 0;
    const m = (el.textContent || '').match(/第 (\d+) \/ (\d+) 题/);
    return m ? Number(m[1]) : 0;
  });
}

// 推进到第 target 题（info 节点必须点「继续」才能前进）。
async function advanceToCounter(page, target) {
  for (let t = 0; t < 40; t++) {
    const cur = await currentCounter(page);
    if (cur === target) return;
    if (cur === 0) { await sleep(250); continue; } // 页面/节点还在切换
    const clicked = await page.$$eval('.btn', btns => {
      const b = btns.find(x => (x.textContent || '').includes('继续'));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!clicked) await sleep(300);
    await sleep(250);
  }
  throw new Error(`无法推进到第 ${target} 题（当前 ${await currentCounter(page)}）`);
}

// 作答/点过第 i 个节点；问题节点作答后等待自动前进到下一题或完成界面。
async function processNode(page, nodes, i) {
  await advanceToCounter(page, i + 1);
  const node = nodes[i];
  if (node.type === 'info') {
    await page.$$eval('.btn', btns => { const b = btns.find(x => (x.textContent || '').includes('继续')); if (b) b.click(); });
    await sleep(300);
    return;
  }
  await answerCurrentNode(page, node);
  // 作答后 ~600ms onAnswer + ~800ms 自动前进；等计数器到下一题或直接到完成界面
  for (let t = 0; t < 40; t++) {
    if (i + 1 >= nodes.length) break;
    const cur = await currentCounter(page);
    if (cur === i + 2) break;
    const finished = await page.evaluate(() => document.body.innerText.includes('小节完成！'));
    if (finished) break;
    await sleep(250);
  }
}

async function answerCurrentNode(page, node) {
  if (node.type === 'info') {
    await page.click('button:has-text("继续")').catch(async () => {
      await page.$$eval('.btn', btns => {
        const b = btns.find(x => x.textContent.includes('继续'));
        if (b) b.click();
      });
    });
    return;
  }
  if (node.type === 'true_false') {
    const want = node.correct_answer === true ? '正确' : '错误';
    await page.$$eval('.option-btn', (btns, w) => {
      const b = btns.find(x => (x.querySelector('span:last-child')?.textContent || '').trim() === w);
      if (b) b.click();
    }, want);
    return;
  }
  if (node.type === 'multiple_choice') {
    const want = node.options.find(o => o.is_correct)?.text;
    await page.$$eval('.option-btn', (btns, w) => {
      const b = btns.find(x => (x.querySelector('span:last-child')?.textContent || '').trim() === w);
      if (b) b.click();
    }, want);
    return;
  }
  if (node.type === 'fill_blank') {
    const ans = correctAnswerFor(node) || '';
    await page.$eval('.fill-blank-input', (inp, v) => {
      // React 18 用 value tracker 接管实例 value setter：直接赋值 + input 事件不会
      // 触发 onChange。走原型 setter（标准 React 测试配方）才能被 React 识别。
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, v);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, ans);
    await sleep(150);
    await page.click('.fill-confirm-btn');
  }
}

const backend = spawn(NODE24, [path.join(ROOT, 'backend', 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DLG_DB_PATH: DB_PATH,
    DLG_RATE_MAX_register: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
backend.stderr.on('data', d => process.stderr.write(`[backend] ${d}`));
backend.stdout.on('data', d => process.stdout.write(`[backend] ${d}`));

let browser;
try {
  await waitHealth();
  console.log('后端就绪');

  // ── X07 安全头 ──
  console.log('\n== X07 安全头 ==');
  const head = await apiReq('GET', '/', null, null);
  assert(head.headers['x-powered-by'] === undefined, '无 X-Powered-By');
  assert(String(head.headers['x-content-type-options']).toLowerCase() === 'nosniff', 'X-Content-Type-Options: nosniff');
  assert(String(head.headers['x-frame-options']).toUpperCase() === 'DENY', 'X-Frame-Options: DENY');
  assert(String(head.headers['referrer-policy']).startsWith('strict-origin-when-cross-origin'), 'Referrer-Policy');
  assert(!!head.headers['content-security-policy'], 'Content-Security-Policy 存在');
  assert(String(head.headers['content-security-policy']).includes("script-src 'self'"), 'CSP script-src self（无 inline/eval）');

  const manifest = await apiReq('GET', '/manifest.webmanifest', null, null);
  assert(manifest.status === 200, 'manifest 可拉取 (HTTP 200)');
  assert(String(manifest.headers['content-type']).includes('application/manifest+json'), `manifest content-type=${manifest.headers['content-type']}`);
  const sw = await apiReq('GET', '/sw.js', null, null);
  assert(sw.status === 200, 'sw.js 可拉取');

  // 注册用户
  const reg = await apiReq('POST', '/api/auth/register', null, { username: `pwa_${Date.now()}`, password: 'testpass123' });
  assert(reg.status === 200 && reg.body.token, '注册成功拿到 token');
  const token = reg.body.token;

  // ── 浏览器会话 ──
  const puppeteer = (await import('puppeteer')).default;
  const chrome = resolveChrome();
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: path.join('D:\\tmp', `dlg_pwa_profile_${Date.now()}`),
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000, isMobile: false });

  const pageErrors = [];
  const cspViolations = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Content Security Policy|Refused to/.test(t)) cspViolations.push(t);
    }
  });
  // 注入 token 使 app gate 放行（与 e2e_helpers.injectAuth 一致）
  await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('dlg_token', t); } catch (e) {} }, token);

  console.log('\n== X02 在线：壳 + SW + 缓存 ==');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(1200);
  const hasRoot = await page.evaluate(() => !!document.querySelector('#root') && document.getElementById('root').innerHTML.length > 50);
  assert(hasRoot, '首页渲染（React 挂载）');

  // SW 注册 + 激活
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return { hasReg: !!reg, active: reg && reg.active ? reg.active.state : null, controller: !!navigator.serviceWorker.controller };
  });
  assert(swState.hasReg && swState.active === 'activated', `SW 注册并激活 (state=${swState.active})`);

  // 重新加载一次，确保 SW 接管所有请求（clients.claim 生效）→ 资产全部入缓存
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(800);
  const cacheKeys = await page.evaluate(() => caches.keys().then(k => k.filter(x => x.startsWith('dlg-')).sort()));
  assert(cacheKeys.includes('dlg-shell-1.0.0'), `壳缓存存在 (${cacheKeys.join(', ')})`);

  // 加载课程内容页（触发课程 GET 缓存），在线完成一遍验证 CSP 下全流程可用
  console.log('\n== 在线完成课程（CSP 兼容性）==');
  const lesRes = await apiReq('GET', `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}`, token, null);
  assert(lesRes.status === 200, '拉取课程 JSON');
  const lesson = lesRes.body;

  await page.goto(LESSON_URL, { waitUntil: 'networkidle2' }).catch(() => {});
  await advanceToCounter(page, 1);
  // crosscheck5 X M11：原断言 `|| true` 恒真（永远绿）。改为真检查——课程播放器
  // 渲染出 .question-node 才算进入课程页（离线场景下 body 文本未必含精确题干）。
  const enteredLesson = await page.evaluate(() => document.querySelector('.question-node') !== null);
  assert(enteredLesson, '进入课程页（.question-node 已渲染）');

  // 逐节点作答
  for (let i = 0; i < lesson.nodes.length; i++) {
    await processNode(page, lesson.nodes, i);
  }
  // 等待在线完成界面
  await page.waitForFunction(() => document.body.innerText.includes('小节完成！'), { timeout: 15000 }).catch(() => {});
  const finishedOnline = await page.evaluate(() => document.body.innerText.includes('小节完成！'));
  assert(finishedOnline, '在线完成 → 显示完成界面');
  assert(cspViolations.length === 0, `在线全程无 CSP 违规 (${cspViolations.length})`);
  assert(pageErrors.length === 0, `无页面 JS 错误 (${pageErrors.slice(0, 2).join('; ') || 0})`);

  // 课程 GET 应已入 dlg-lessons 缓存（SW 缓存的是 /api/courses/... 接口路径）
  const lessonCached = await page.evaluate((apiKey) => {
    return caches.open('dlg-lessons-1.0.0').then(c => c.keys()).then(ks => ks.some(r => r.url.includes(apiKey)));
  }, `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}`);
  assert(lessonCached, '课程内容 GET 已入缓存');

  console.log('\n== X02 离线：壳 + 课程命中缓存 ==');
  await page.setOfflineMode(true);
  // 离线重载课程页：SW 应返回缓存壳 + 缓存课程
  await page.goto(LESSON_URL, { waitUntil: 'networkidle0' }).catch(e => console.warn('  离线 goto 提示:', e.message));
  await sleep(1500);
  const offlineShell = await page.evaluate(() => ({
    hasRoot: !!document.getElementById('root') && document.getElementById('root').innerHTML.length > 50,
    offlineBanner: !!document.querySelector('.offline-banner'),
    text: document.body.innerText.slice(0, 80),
  }));
  assert(offlineShell.hasRoot, '离线重载：应用壳从缓存加载');
  assert(offlineShell.offlineBanner, '离线启动：显示「离线模式」横幅（缓存身份恢复）');
  const offlineLessonRendered = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.question-node, .lesson-container')];
    return els.length > 0 && document.body.innerText.includes('小节') === false && document.body.innerText.length > 100;
  });
  assert(offlineLessonRendered, '离线：课程页从缓存渲染（未白屏）');

  console.log('\n== X02 离线完成 → 入队 ==');
  // 逐节点作答（离线）
  for (let i = 0; i < lesson.nodes.length; i++) {
    await processNode(page, lesson.nodes, i);
  }
  await sleep(2500);
  const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('dlg_offline_queue') || '[]'));
  assert(queue.length === 1, `离线完成入队 1 条（实际 ${queue.length}）`);
  assert(queue[0]?.status === 'pending', `条目 status=pending（实际 ${queue[0]?.status}）`);
  assert(typeof queue[0]?.client_request_id === 'string' && queue[0].client_request_id.length >= 8, '条目带 client_request_id');
  assert(queue[0]?.lessonId === LESSON, `条目记录课程 ${queue[0]?.lessonId}`);
  const offlineToast = await page.evaluate(() => document.body.innerText.includes('已本地暂存') || document.body.innerText.includes('自动同步'));
  assert(offlineToast, '显示「离线暂存/自动同步」提示');

  console.log('\n== X02 重连 → flush 同步 ==');
  await page.setOfflineMode(false);
  await sleep(500);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // 等 flush 完成（轮询 localStorage）
  let synced = false;
  for (let i = 0; i < 20; i++) {
    const q = await page.evaluate(() => JSON.parse(localStorage.getItem('dlg_offline_queue') || '[]'));
    if (q[0]?.status === 'synced') { synced = true; break; }
    await sleep(500);
  }
  assert(synced, 'flush 后条目状态 → synced');

  // 服务端幂等收据落库（直查 DB）
  const checkDb = await new Promise((resolve) => {
    const Database = require(path.resolve('backend', 'node_modules', 'better-sqlite3'));
    let db;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const rows = db.prepare('SELECT COUNT(*) c FROM submission_receipts').get();
      const progress = db.prepare('SELECT COUNT(*) c FROM progress WHERE lesson_id = ?').get(`${COURSE}/${UNIT}/${LESSON}`);
      resolve({ receipts: rows?.c || 0, progress: progress?.c || 0 });
    } catch (e) { resolve({ error: e.message }); }
    finally { try { db && db.close(); } catch {} }
  });
  assert(checkDb.receipts >= 1, `服务端收据落库 (${checkDb.receipts} 条)`);
  assert(checkDb.progress >= 1, `服务端 progress 落库 (${checkDb.progress} 条)`);

  console.log(failures === 0 ? `\n✅ PWA e2e 全部通过（${passed} 项）` : `\n❌ ${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error('测试异常:', e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  backend.kill();
  setTimeout(() => {
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
    process.exit(process.exitCode);
  }, 500);
}

function resolveChrome() {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  const cache = puppeteerCacheChrome();
  const candidates = [
    ...cache,
    ...(process.platform === 'win32'
      ? [
          process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
          process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']),
  ];
  const found = candidates.find(c => c && fs.existsSync(c));
  if (!found) throw new Error('未找到 Chrome/Chromium，请设置 BROWSER_PATH 环境变量或先 npx puppeteer browsers install chrome');
  return found;
}

// puppeteer 缓存的 chrome（CI 无系统 Chrome 时 npx puppeteer browsers install chrome 装到这里）
function puppeteerCacheChrome() {
  const root = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer', 'chrome')
    : process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library', 'Caches', 'puppeteer', 'chrome')
    : path.join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome');
  const out = [];
  try {
    for (const ver of fs.readdirSync(root)) {
      const dir = path.join(root, ver);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const sub of fs.readdirSync(dir)) {
        out.push(path.join(dir, sub, process.platform === 'win32' ? 'chrome.exe' : 'chrome'));
      }
    }
  } catch {}
  return out;
}
