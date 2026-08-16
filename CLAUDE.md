# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

## 项目定位

DLG 电工考证学习系统——一个**开箱即用的电工考证备考平台**：微课精讲 + 服务端判分练习 + 全真模拟考 + 游戏化激励（金币 / 生命 / 错题 SM-2 复习 / 段位排行榜）。面向「低压电工作业证」等电工类考试。

- **前端**：React 18 + Vite（`frontend/`，开发端口 5173，`/api` 代理到后端 3001）
- **后端**：Express + better-sqlite3（`backend/`，端口 3001，单文件 SQLite）
- **内容**：`backend/data/courses/` 下 JSON（3 课程 / 28 单元 / 703 微课 + 模拟考多选池 = **704 课时 / 5020 节点**），实时读盘，改完刷新即生效

## ⚠️ Node 版本硬性要求（≥ 24）

**本仓库必须用 Node ≥ 24。** `better-sqlite3@13.0.3` 的预编译二进制在 Node 20 上会段错误（segfault）。

- 本机测试用：`PATH="/path/to/node24:$PATH" npm test`（`node24` 指 Node 24 二进制所在目录，或用 nvm 切到 24）
- `backend/package.json` 的 `engines.node` 已设 `>=24`
- 生产部署：`node:24-slim`（Docker）或 `setup_24.x`（nodesource）
- 测试脚本首行会校验 Node 主版本，低于 22 直接退出

## 测试门禁（9 段链，`cd backend && npm test`）

`npm test` 是 `&&` 串联链，任一环节失败即整体失败。全绿 = 126 断言：

| 段 | 脚本 | 断言 | 覆盖 |
| --- | --- | --- | --- |
| 1 | `node ../scripts/validate_content.cjs` | 0 ERROR / 0 WARN | 扫描全部课程 JSON 结构 |
| 2 | `node ../test_api.mjs` | 44 | 注册/登录/课程/判分/金币/检查点/SM-2 |
| 3 | `node ../smoke_milestone1.mjs` | 20 | 核心业务流程冒烟 |
| 4 | `node ../test_leaderboard_v2.mjs` | 12 | 段位/周结算/排行 |
| 5 | `node ../smoke_settlement.mjs` | 14 | 周结算事务/幂等 |
| 6 | `node ../test_security_invariants.mjs` | 19 | **安全不变量**：错题卡脱敏缺席、register 独立桶、login-user-global 兜底、模拟考及格路径、多选 remap + 复习重映射、错题卡 5 类答案键剥离、rate_limit 桶、simulation_danger 负例 |
| 7 | `node ../test_idempotency.mjs` | 17 | (user, client_request_id) 幂等重放不二次判分/铸币 |
| 8 | `node ../scripts/grade_scan.cjs` | 3742 节点 100% + 3741 错答负例 | 判分自洽 + 宽容化回归 |
| 9 | `node ../scripts/check_data_integrity.cjs` | 704 lessons | 数据完整性 |

> 门禁链数字若有变动，需同步更新本文件、`README.md`、`docs/快速开始.md`、`docs/测试说明.md`。

## 架构关键点（务必遵守）

- **判分真源在服务端**：`backend/lib/grading.js`，前端不可篡改。前端 `LessonPlayer.jsx` 有镜像 `_fbNormalize` 本地判对，必须保持「本地判对 = 服务端判对」一致。判分结果逐节点落库 `node_results`。
- **服务端经济**：金币/xp/生命全部由服务端结算（`routes/courses.js`、`routes/game.js`、`lib/shop.js`），客户端只能提交行为、不能自报奖励。
- **DB 不透明 token**：`backend/middleware/auth.js`，会话 token SHA-256 哈希入库，Session 表不可逆。
- **限流**：`backend/middleware/rate_limit.js` 内存固定窗口桶。`DLG_RATE_MAX_<scope>` 环境变量可覆盖上限（测试套件用它放开 auth-ip/register）。prod 不设则用默认。register 独立桶 5/15min/IP、auth-ip 20/15min、login-user 5/15min/IP+账号、login-user-global 20/15min/账号（跨 IP 兜底）、change-pw 10/15min。
- **错题卡脱敏**：`routes/game.js` sanitizeMistakeForClient 删除 `correct_answer/answer/acceptable_answers/explanation/correct_order/options[].is_correct` + 5 类题型答案键（`match.pairs`、`drag_drop.target_zone/distractors`、`simulation_dial.dial_options[].is_correct/is_wrong`、`simulation_probe.correct_probes`、`multimeter_challenge.correct_setup/correct_display`），答案仅在提交复习后揭示。任何新增答案键必须同步进脱敏名单与 `test_security_invariants.mjs` 的 BANNED 列表。
- **模拟考**：`/exam/start` 生成 100 题（60 判断 + 30 单选 + 10 多选），multi_select 选项 id **会话级随机重映射**（`ms-xxxx` 格式，防 `{A,B}` 盲刷），`/exam/submit` 服务端判分，score≥80 及格、xp30、首过 30 币、及格卷错题入册。**错题卡复习再重映射**：ms_pool 错题卡入册时生成 `remap_json`（池选项 id → 随机 `ms-xxxx`，旧卡首次复习兜底生成），`loadMistakeNode` 应用它，复习判分看到的正确集合逐卡移动——盲猜池固定正确项 `["A","B"]` 无法铸币。
- **simulation_danger**：判分只接受精确的 `安全操作` 或规范形式 `安全操作（先换表笔再测量）`，**不做子串匹配**（否则「不安全操作」会被「安全操作」误判为对）。
- **判分归一化** `grading.js _normalize`：半角化 → Ω 哨兵屏蔽(U+E000) → **m/M SI 前缀大小写屏蔽(U+E001)** → toLowerCase → 去空白。改它时同步前端镜像。
- **测试设施**：`test_api.mjs` / `test_security_invariants.mjs` 用 spawn 独立 server（`PORT=399x`、`DLG_DB_PATH=临时库`、放开 `DLG_RATE_MAX_auth-ip`），不碰真实 `app.db`。

## 安全红线（不可违反）

- `app.db` 含真实用户密码哈希 → 保持 gitignored/untracked，**绝不外泄、绝不公开推送**。
- 公开仓经 `/d/tmp/dlg_public` 孤儿快照 + exclusion list 同步（排除 `audit/`、`shiqun_*.txt`、万用表图片、内部文档），**绝不公开推送本地 git 历史**。
- `ADMIN_TOKEN` 管理口令 fail-closed：未设置则管理接口 503；别写进前端或 git。
- 破坏性 app.db 操作前先备份；实验脚本/下载放 `D:\tmp`。

## 已知取舍（已评估、显式接受）

- **课程接口答案键**：GET lesson（鉴权门）返回答案键供前端即时本地反馈——登录用户可读到答案、答满分拿合法奖励/排名。这不铸币（奖励服务端独立判分），残留是「排行榜满分机器人」。已加 `lesson-views` 限流（240/15min/IP）挡整库抓取；彻底修需拆端点（每节点在线判分），会牺牲离线学习与即时反馈，取舍后接受。见 `docs/API.md` 限流表。

## 工作约定

- **文档/报告/记忆条目一律用中文**（代码注释不受限）。
- 审计报告只写 `audit/` 下（允许），不污染仓库根。
- 发布门禁 = `cd backend && npm test` 全绿 + `cd frontend && npm run build` 成功。
- 任务推进顺序（roadmap）：鉴权基线 → 测试隔离 → 判分真源 → 结算事务 → 奖励闭环 → 错题SM-2 → 内容硬错误 → 内容CI。
