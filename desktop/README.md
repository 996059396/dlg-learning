# DLG 电工学习系统 —— 桌面壳（X01）

Electron 同源桌面壳：不修改任何 frontend 源码，把「后端伺服构建产物」变成桌面应用。

## 原理

后端 `backend/server.js` 已能伺服 `frontend/dist`（单源 + SPA fallback）。本壳只做两件事：

1. 用**系统 Node 24**（ABI 137，better-sqlite3 v13 预编译约束；Electron 内嵌 Node 不满足）启动后端，
   环境 `HOST=127.0.0.1`（仅回环）+ 端口自动避让；
2. `BrowserWindow` 加载 `http://127.0.0.1:<port>` —— 同源，无 CORS。

端口策略：3001 空闲 → 用 3001；3001 已有 DLG 后端 → **复用**（不重复启动，避免两进程并发开 app.db）；
3001 被非 DLG 进程占用 → 顺延到 3002…3010 的第一个空闲端口。

安全：`nodeIntegration:false` + `contextIsolation:true` + `sandbox:true`；单实例锁保证只有一个桌面实例。

## 运行

```bash
# 首次：安装 electron（约 100MB）
cd desktop && npm install

# 国内网络：GitHub releases 二进制下载常超时（connect ETIMEDOUT），用镜像
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
# 版本号精确锁定（36.5.0，不用 ^）以命中本机 electron 缓存，避免每次解析最新版重新下载。

# 需要 Node 24 可执行文件。设 DLG_NODE24 指向 node24 的 node.exe，或确保 PATH 上的 node 是 ABI 137（Node 24）即可；
# 其他机器请装 Node 24 并设置 DLG_NODE24 指向它的 node.exe，或让 `node` 在 PATH 上且 ABI=137。

# 启动桌面壳
npm start

# CI 冒烟（加载后断言标题含 DLG，SMOKE_OK 退出 0；Linux runner 用 xvfb-run）
npm run smoke
```

> 前端构建产物由 `frontend/dist` 提供。源码改动后先 `cd frontend && npm run build` 再启动壳。

## 分发打包（后续）

`electron-builder` 打包三平台（`--win --mac --linux`），Node 24 可执行文件随包分发
（`extraResources`），`resolveNode()` 已预留候选顺序，届时加入打包路径即可。
