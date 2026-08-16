#!/usr/bin/env node
// 本地仓库全量备份（crosscheck5 P M2）：生成 git bundle（含完整历史——审计轨迹、
// shiqun 版权素材、内部文档），落到可配置目录。备份的是 .git 对象库的打包，不是
// 工作树副本；恢复时 `git clone backup.bundle new-repo` 即可。
//
// 注意：这只是防「仓库损坏/误删」，不是防「磁盘故障」（默认同盘）。有第二块盘时
// 设 DLG_REPO_BACKUP_DIR 指过去。
// 用法：node scripts/backup_repo.cjs [备注]
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.DLG_REPO_BACKUP_DIR || path.join('D:', 'tmp', 'dlg_repo_backups');
fs.mkdirSync(OUT_DIR, { recursive: true });

const note = process.argv[2] ? `_${process.argv[2].replace(/[^\w-]/g, '')}` : '';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const file = path.join(OUT_DIR, `dlg_backup_${stamp}${note}.bundle`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`❌ ${cmd} ${args.join(' ')} 失败:`, r.stderr || r.stdout);
    process.exit(1);
  }
  return r;
}

// 全部分支/全部历史 + 所有 tag 打包成一个自包含 bundle。
const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
run('git', ['bundle', 'create', file, '--all']);
const size = fs.statSync(file).size;
const info = run('git', ['log', '-1', '--format=%h %s'], { cwd: ROOT }).stdout.trim();
console.log(`✅ 仓库备份完成 → ${file}`);
console.log(`   大小 ${(size / 1024 / 1024).toFixed(1)} MB | HEAD ${head.slice(0, 8)} | ${info}`);
console.log(`   恢复: git clone ${file} <新目录>`);
console.log(`   提示: 默认同盘(D:)，仅防仓库损坏/误删；有第二块盘请设 DLG_REPO_BACKUP_DIR。`);
