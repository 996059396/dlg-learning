// DLG 电工学习系统 —— Electron 同源桌面壳 (X01)
//
// 设计目标：frontend 零改动。后端 server.js 已能伺服构建产物（frontend/dist）并带
// SPA fallback，所以这里只做两件事：
//   1. 用系统 Node 24（ABI 137，better-sqlite3 v13 预编译约束）spawn backend/server.js，
//      HOST=127.0.0.1（桌面场景仅回环，无需 LAN 暴露）；端口自动避让：3001 空闲→3001，
//      3001 已被 DLG 后端占用→复用（不重复启动后端，避免两进程并发开 app.db），
//      3001 被非 DLG 进程占用→顺延到下一个空闲端口。
//   2. BrowserWindow 加载 http://127.0.0.1:<port> —— 同源，无 CORS、无跨域。
//
// 安全：nodeIntegration:false + contextIsolation:true + sandbox:true；单实例锁防止
// 两个桌面实例各自起后端、各自开 app.db（SQLite WAL 并发写的坑，见 backend 端口互斥注释）。
//
// 冒烟模式 `electron . --smoke`：加载完成后断言页面标题含 "DLG"，打印 SMOKE_OK 退出 0，
// 供 CI 三平台验证（Windows runner 有桌面会话；Linux runner 用 xvfb-run）。

'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = path.join(__dirname, '..', 'backend');
const ABI_REQUIRED = 137; // better-sqlite3 v13 预编译 ABI（server.js 有同值预检）

let backend = null;      // 本进程 spawn 的后端子进程（仅当端口是我们占用的）
let ownsBackend = false; // 复用既有后端时不杀它
let backendPort = null;
let mainWindow = null;
let quitting = false;
const isSmoke = process.argv.includes('--smoke');

// ── 端口 / 健康探测 ────────────────────────────────────────────────────────
function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
function healthOk(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function chooseBackend() {
  if (await healthOk(3001)) return { port: 3001, reuse: true };
  for (let p = 3001; p <= 3010; p++) {
    if (!(await portInUse(p))) return { port: p, reuse: false };
  }
  throw new Error('3001–3010 端口均被占用，无法启动后端');
}

// ── 定位 Node 24（ABI 137）─────────────────────────────────────────────────
// Electron 内嵌的 Node 不是 ABI 137，直接 spawn 后端会死在 server.js 的 ABI 预检上；
// 必须用系统 Node 24。候选顺序：DLG_NODE24 环境变量 → 本机已知路径 → PATH 上的 node，
// 逐个用 `node -e "process.versions.modules"` 实测 ABI，通过才用。
function probeAbi(nodeExe) {
  return new Promise((resolve) => {
    if (!nodeExe) return resolve(null);
    // 只有「路径形式」（含 / 或 \）才做 existsSync 预检；裸命令名（如 'node'）
    // 靠 PATH 解析，existsSync 会在 CWD 找不到同名文件而误杀它（CI 三平台因此
    // 报「未找到 Node 24」，本机则因候选#2 绝对路径存在而侥幸通过）。
    const isPath = /[\\/]/.test(nodeExe);
    if (isPath && !fs.existsSync(nodeExe)) return resolve(null);
    const child = spawn(nodeExe, ['-e', 'process.stdout.write(String(process.versions.modules))'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 && out.trim() === String(ABI_REQUIRED) ? nodeExe : null));
  });
}
async function resolveNode() {
  const candidates = [
    process.env.DLG_NODE24,
    'C:\\Users\\moxo\\node24\\node.exe', // 本机开发机
    'node',                               // PATH 兜底（能过 ABI 预检才算数）
  ];
  for (const c of candidates) {
    const ok = await probeAbi(c);
    if (ok) return ok;
  }
  throw new Error('未找到 Node 24 (ABI 137)。better-sqlite3 v13 需要 Node 24，请设置 DLG_NODE24 指向 node24 的 node.exe。');
}

// ── 启动后端 ───────────────────────────────────────────────────────────────
async function startBackend() {
  const { port, reuse } = await chooseBackend();
  backendPort = port;
  if (reuse) {
    ownsBackend = false;
    console.log(`[dlg-desktop] 复用已运行的后端 http://127.0.0.1:${port}`);
    return;
  }
  const nodeExe = await resolveNode();
  ownsBackend = true;
  backend = spawn(nodeExe, [path.join(BACKEND_DIR, 'server.js')], {
    cwd: BACKEND_DIR,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  backend.on('error', (err) => { if (!quitting) console.error('[dlg-desktop] 后端 spawn 失败:', err); });
  backend.on('exit', (code) => {
    if (!quitting && code !== 0) console.error(`[dlg-desktop] 后端意外退出 (exit ${code})`);
  });
  for (let i = 0; i < 60; i++) {
    if (await healthOk(port)) {
      console.log(`[dlg-desktop] 后端已就绪 http://127.0.0.1:${port}`);
      return;
    }
    if (backend.exitCode !== null) throw new Error(`后端启动失败 (exit ${backend.exitCode})`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('后端 30 秒内未就绪');
}

function killBackend() {
  if (!backend || !ownsBackend) return Promise.resolve();
  const child = backend;
  backend = null;
  return new Promise((resolve) => {
    const onExit = () => resolve();
    child.once('exit', onExit);
    try { child.kill(); } catch (e) { child.removeListener('exit', onExit); resolve(); return; }
    // 兜底：3 秒后不再等（Windows 上子进程若未及时退出，parent 先退会孤儿化）
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(); }, 3000);
    if (timer.unref) timer.unref();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 480,
    minHeight: 700,
    title: 'DLG电工',
    autoHideMenuBar: true,
    backgroundColor: '#1F1F1F',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);
  mainWindow.on('closed', () => { mainWindow = null; });

  if (isSmoke) {
    // CI 冒烟：加载完成后等待 app gate 渲染真实内容，断言标题含 DLG 即通过。
    // app.exit() 不触发 will-quit，所以在这里先 await 后端退出再退出，避免子进程孤儿化。
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        let code = 1;
        try {
          const title = await mainWindow.webContents.executeJavaScript('document.title');
          if (String(title).includes('DLG')) {
            console.log('SMOKE_OK ' + JSON.stringify({ title, port: backendPort }));
            code = 0;
          } else {
            console.error('SMOKE_FAIL title 不含 DLG: ' + title);
          }
        } catch (e) {
          console.error('SMOKE_FAIL: ' + e.message);
        }
        quitting = true;
        await killBackend();
        app.exit(code);
      }, 2500);
    });
  }
}

// ── 生命周期 ───────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // 已有实例在跑，避免第二个后端并发开 app.db
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setName('DLG电工');
  app.whenReady().then(async () => {
    try {
      await startBackend();
    } catch (e) {
      console.error('[dlg-desktop] 启动失败:', e.message || e);
      // smoke/CI 下不弹模态框，直接以非零退出（模态框会阻塞 CI 直到被点掉）。
      if (!isSmoke) dialog.showErrorBox('DLG电工 启动失败', String((e && e.message) || e));
      app.exit(1);
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => { app.quit(); });
  app.on('will-quit', (event) => {
    quitting = true;
    // Windows 下 parent 退出不会自动带走子进程 —— 若不等待，spawn 的后端会孤儿化，
    // 一直占着 3001 并持有 app.db。preventDefault 等它真正退出再 quit。
    if (backend && ownsBackend) {
      event.preventDefault();
      killBackend().then(() => app.quit());
    }
  });
}
