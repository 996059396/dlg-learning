#!/usr/bin/env node
// 离机备份（crosscheck5 P M2 / 用户决策⑦）：把本地仓库（含 audit/ 内部物）推到
// GitHub 私有仓 dlg-backup 作离机备份点。与公开仓同步的区别：**保留 audit/**，
// 仅排除版权物（shiqun_*、万用表图片、parser 提取物）与 gitignored 文件。
// 备份的是快照（工作树全量），不是 git 历史——含版权素材的完整历史只留本地。
//
// 用法：node scripts/backup_remote.cjs   （推送到 996059396/dlg-backup main）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg_backup_'));
const REMOTE = process.env.DLG_BACKUP_REMOTE || 'https://github.com/996059396/dlg-backup.git';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    cwd: opts.cwd || ROOT,
  });
  if (r.status !== 0) { console.error(`❌ ${cmd} ${args.join(' ')} 退出 ${r.status}`); process.exit(1); }
  return opts.capture ? r.stdout.trim() : r;
}

const sha = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true });

// 1) git archive → 解出全量（不含 gitignored：node_modules/app.db/dist 都不进）
run('git', ['archive', 'HEAD', '-o', path.join(WORK, 'snap.tar')]);
const tree = path.join(WORK, 'tree');
fs.mkdirSync(tree, { recursive: true });
// 相对路径解压（Windows bsdtar 会把 -f/-C 的盘符冒号当远程主机）
run('tar', ['-xf', path.join('..', 'snap.tar')], { cwd: tree });

// 2) 剔除版权物（shiqun 字幕、万用表图片、parser 提取数据）
const EXCLUDE = ['shiqun_', '万用表图片', 'parser/chunks', 'parser/extracted', 'parser/manifest.json', 'parser/chunks_args.json'];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(path.join(WORK, 'tree'), abs).replace(/\\/g, '/');
    const drop = EXCLUDE.some(p => rel.startsWith(p) || e.name.startsWith('shiqun_'));
    if (drop) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    if (e.isDirectory()) walk(abs);
  }
})(path.join(WORK, 'tree'));

// 3) 本地 commit + push 到私有备份仓
if (!fs.existsSync(path.join(tree, '.git'))) run('git', ['init', '-q', '-b', 'main'], { cwd: tree });
run('git', ['add', '-A'], { cwd: tree });
const changed = run('git', ['status', '--porcelain'], { cwd: tree, capture: true }).split('\n').filter(Boolean).length;
if (changed > 0) {
  run('git', ['-c', 'user.email=dlg-backup@bot', '-c', 'user.name=dlg-backup', 'commit', '-q', '-m', `backup snapshot ${sha}`], { cwd: tree });
  run('git', ['remote', 'add', 'origin', REMOTE], { cwd: tree, });
  // 备份是「当前状态快照」，非递增历史 → force-push（私有仓无协作者，安全）
  run('git', ['push', '-q', '-u', 'origin', 'main', '--force'], { cwd: tree });
  console.log(`✅ 离机备份完成：${REMOTE} @ ${sha}（${changed} 变更）`);
} else {
  console.log('无变更，跳过推送。');
}
fs.rmSync(WORK, { recursive: true, force: true });
