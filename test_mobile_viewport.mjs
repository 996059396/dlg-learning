#!/usr/bin/env node
// 移动端视口回归横扫（用户决策④「模拟器里测试一切」）：
// 390px 移动视口访问全部关键页面，断言无横向溢出（scrollWidth <= innerWidth）。
// 自建独立后端(3100)伺服构建产物 dist + 隔离 DB——CI e2e-browser 可直接跑，不碰 live。
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { launch, injectAuth, injectProgress } from './e2e_helpers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE24 = process.env.DLG_NODE24 || process.execPath;
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `dlg_mob_${Date.now()}.db`);

const PAGES = [
  ['/', '首页'],
  ['/course/electrician_prereq/unit/e0_elementary', '课程树(前置)'],
  ['/course/electrician_basics/unit/u1_meter_basics', '课程树(理论)'],
  ['/course/electrician_exam/unit/s1_safety_firstaid', '课程树(考证)'],
  ['/lesson/electrician_basics/u1_meter_basics/l1_intro', '课程播放器'],
  ['/exam', '模拟考'],
  ['/shop', '商店'],
  ['/leaderboard', '排行榜'],
  ['/profile', '我的'],
  ['/review', '错题医疗包'],
];

function apiReq(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
function waitHealth() { return new Promise((resolve, reject) => { let t = 0; const tick = () => apiReq('GET', '/api/health').then(() => resolve()).catch(() => (++t > 60 ? reject(new Error('后端未就绪')) : setTimeout(tick, 500))); tick(); }); }

// 自起后端（3100 段，隔离 DB），伺服 frontend/dist
const backend = spawn(NODE24, [path.join(ROOT, 'backend', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DLG_DB_PATH: DB_PATH, DLG_RATE_MAX_register: '500' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
await waitHealth();

let failed = 0;
async function check(page, p, label) {
  await page.goto(BASE + p, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  const overflow = m.sw > m.iw + 1;
  console.log(`  ${overflow ? '❌' : '✅'} ${label} (${p}) — scrollWidth=${m.sw} innerWidth=${m.iw}${overflow ? ` 溢出 ${m.sw - m.iw}px` : ''}`);
  if (overflow) failed++;
}

const reg = await apiReq('POST', '/api/auth/register', null, { username: `mob${Date.now() % 100000}`, password: 'testpass123' });
const token = reg.token;
const browser = await launch();
const page = await browser.newPage();
await injectAuth(page, token);
await injectProgress(page, { 'electrician_basics/u1_meter_basics/l1_intro': { completed: true, accuracy: 100 } });

console.log('移动视口(390px)横扫：');
for (const [p, l] of PAGES) { try { await check(page, p, l); } catch (e) { failed++; console.log(`  ❌ ${l} 异常: ${e.message.slice(0, 80)}`); } }

await browser.close();
backend.kill();
console.log(failed === 0 ? '\n✅ 移动视口全部无溢出' : `\n❌ ${failed} 处横向溢出`);
process.exit(failed === 0 ? 0 : 1);
