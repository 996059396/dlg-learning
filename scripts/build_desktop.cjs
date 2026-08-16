#!/usr/bin/env node
// DLG 桌面安装包构建（crosscheck5 X L21 / 用户决策「三平台产安装包」）。
// 1) 确保 frontend/dist 已构建；
// 2) 准备 desktop/vendor/node24（内嵌 Node 24：优先复制本机 node24，否则从 nodejs.org 下载当前平台 zip）；
// 3) 跑 electron-builder 产出当前平台的安装包（win→nsis+portable，mac→dmg+zip，linux→AppImage+deb）。
//
// 用法：node scripts/build_desktop.cjs   （在仓库根运行）
// 产物：desktop/release/  （*.exe / *.dmg / *.AppImage）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

(async () => {

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const VENDOR = path.join(DESKTOP, 'vendor', 'node24');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'inherit', ...opts });
  // robocopy 退出码 0-7 都是成功（1=有文件被复制）；≥8 才是错误。
  const isRobocopy = cmd.toLowerCase().includes('robocopy');
  if (r.status && (isRobocopy ? r.status >= 8 : r.status !== 0)) {
    console.error(`❌ ${cmd} ${args.join(' ')} 退出 ${r.status}`); process.exit(1);
  }
  return r;
}

// ── 0) 红线预检：源码树必须不含任何 *.db（crosscheck6 P3 critical——
//    安装包曾内嵌真实 app.db 含密码哈希。含 db 直接 fail）。 ────────────────
const leaked = [];
(function walkDbs(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      // 跳过 node_modules/.git；backend/models/data 是开发库目录，extraResources
      // 已排除它——预检范围与安装包内容一致（防的是泄漏，不是开发库存在）。
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (p.endsWith(path.join('backend', 'models', 'data'))) continue;
      walkDbs(p);
    }
    else if (/\.(db|db-wal|db-shm)$/i.test(e.name)) leaked.push(p);
  }
})(ROOT);
if (leaked.length) {
  console.error(`❌ 红线：打包源树含 ${leaked.length} 个数据库文件，中止构建（安装包不得携带用户数据）：`);
  for (const p of leaked) console.error('   ' + p);
  process.exit(1);
}
console.log('· 红线预检通过：源码树无 *.db');

// ── 1) 前端构建 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(ROOT, 'frontend', 'dist', 'index.html'))) {
  console.log('· 构建 frontend/dist …');
  run('npm', ['run', 'build'], { cwd: path.join(ROOT, 'frontend') });
} else console.log('· frontend/dist 已存在');

// ── 2) 内嵌 Node 24 ──────────────────────────────────────────────────────────
// 优先用本机已装 node24（LOCAL_NODE24 指向其目录，如本地 node24 解压目录）；
// 未提供则从 nodejs.org 下载当前平台 Node 24。
const LOCAL_NODE24 = process.env.LOCAL_NODE24 || '';
if (LOCAL_NODE24 && fs.existsSync(path.join(LOCAL_NODE24, 'node.exe'))) {
  fs.mkdirSync(VENDOR, { recursive: true });
  console.log(`· 复制本机 node24（${LOCAL_NODE24}）→ desktop/vendor/node24`);
  run('robocopy', [LOCAL_NODE24, VENDOR, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);
} else {
  // 无本机 node24：从 nodejs.org 下载当前平台 Node 24 二进制（CI/其他机器）。
  console.log(`· 未提供 LOCAL_NODE24 或不存在，从 nodejs.org 下载`);
  const p = process.platform;
  const arch = os.arch(); // x64 / arm64
  const map = {
    win32: `node-v24.x-win-${arch}.zip`,
    darwin: `node-v24.x-darwin-${arch}.tar.gz`,
    linux: `node-v24.x-linux-${arch}.tar.gz`,
  };
  const fname = map[p];
  const url = `https://nodejs.org/dist/latest-v24.x/${fname}`;
  console.log(`· 下载 Node 24: ${url}`);
  const tmp = path.join(os.tmpdir(), fname);
  const res = await fetch(url);
  if (!res.ok) { console.error(`❌ 下载失败 HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.mkdirSync(VENDOR, { recursive: true });
  if (p === 'win32') run('tar', ['-xf', tmp, '-C', VENDOR, '--strip-components=1']);
  else run('tar', ['-xzf', tmp, '-C', VENDOR, '--strip-components=1']);
  console.log('· Node 24 解压完成');
}

// ── 3) electron-builder（程序化 API：config 传 package.json build 字段，cwd 非法——
//    electron-builder JS API 只认 config/targets，传 cwd 会 checkBuildRequestOptions 抛错）─
console.log('· electron-builder …');
const builder = require(path.join(DESKTOP, 'node_modules', 'electron-builder'));
process.chdir(DESKTOP);
await builder.build({ config: require(path.join(DESKTOP, 'package.json')).build });
console.log('\n✅ 安装包产物在 desktop/release/（见文件清单）。');
})();
