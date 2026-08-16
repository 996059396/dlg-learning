# 🔌 API 参考

本仓库的 HTTP 接口，前端 `frontend/src/utils/api.js` 是唯一调用方。**判分与奖励一律以服务端为准**——客户端只提交「题目 id + 用户答案」，正确性、分数、金币/经验/红心的发放全部在服务端完成，客户端不可伪造成绩。

- 基础路径：`/api`（生产环境与前端同源；开发环境由 Vite 5173 代理到后端 3001）
- 请求/响应：JSON（`Content-Type: application/json`），UTF-8
- 时间：除特别说明外均为 UTC；**「今天/昨天/周」一律用 Asia/Shanghai（UTC+8）口径**，见 `database.js` 的 `todayShanghai` / `getWeekStart`
- 所有响应都带安全头（CSP / X-Frame-Options DENY / nosniff / Referrer-Policy 等，见 `server.js`）

---

## 一、鉴权

### 1.1 用户会话

登录/注册签发一个**不透明随机 token**（32 字节 hex），前端存 `localStorage`，此后请求带：

```
Authorization: Bearer <token>
```

- 服务端只存 token 的 **SHA-256 哈希**（`sessions.token_hash`），库泄露不泄露可用 token。
- 有效期：滑动续期 30 天，自创建起最长 **90 天**；过期 token 自动失效（见 `database.js getUserByToken`）。
- 用户名做 NFKC 归一化 + 去除控制字符/零宽字符，最长 24 字符；登录/注册按归一化后名字匹配。

需要登录的接口返回 `401 { "error": "未登录或会话已过期" }`。

### 1.2 管理口令

管理接口（目前只有周结算强制结算）用 **`ADMIN_TOKEN`** 环境变量守卫，请求带：

```
x-admin-token: <ADMIN_TOKEN>
```

- 未设置 `ADMIN_TOKEN` → 管理接口一律 **503 fail-closed**（`{ "error": "服务端未配置 ADMIN_TOKEN" }`）。
- 服务端恒时比较，防时序侧信道。
- 兜底：`ADMIN_USER_ID` 指向的用户 id 也可直接以登录态调用（预留，未使用）。
- 限流：每 IP 30 次/15 分钟，防弱口令在线撞库（见 §三限流表）。

---

## 二、接口一览

### 2.0 健康检查

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 无 | `{ "status": "ok", "timestamp": "<ISO>" }`，供探活/监控 |

### 2.1 认证 `routes/auth.js`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/auth/me` | 登录 | 当前用户信息 + 游戏状态 |
| POST | `/api/auth/register` | 无（独立限流桶） | 注册，签发 token |
| POST | `/api/auth/login` | 无（多重限流） | 登录，签发 token |
| POST | `/api/auth/logout` | 无（读 Bearer） | 撤销当前 token |
| POST | `/api/auth/logout-all` | 登录 | 撤销该用户**全部**会话 |
| POST | `/api/auth/change-password` | 登录 + 限流 | 验证原密码、改新密码、撤销全部会话 |

#### POST /api/auth/register
- 请求体：`{ "username": string, "password": string }`
- `password` 至少 6 位，否则 `400 { "error": "密码至少 6 位" }`。
- 用户名已被占 → **`409`**，统一文案 `{ "error": "注册失败，请更换用户名" }`（**不**明示「用户名已占用」，避免用户名枚举；409/200 本身即枚举面，靠独立限流桶压速，见 §三）。
- 成功：`{ "user": {...}, "token": "..." }`。`user` 含 `id / username / avatar / created_at / last_login` + 全部 `game_state` 字段。

#### POST /api/auth/login
- 请求体：`{ "username": string, "password": string }`
- 用户名不存在 **与** 密码错误统一返回 `401 { "error": "用户名或密码错误" }`（防用户名枚举）。
- 成功：`{ "user": {...}, "token": "..." }`，同时清零该 (IP,用户名) 与全局用户名限流计数，避免真实用户被自己早前失败卡住。

#### POST /api/auth/logout
- 从 `Authorization: Bearer` 读取 token 并撤销。成功 `{ "success": true }`（无需登录态，token 不存在也返回 success）。

#### POST /api/auth/logout-all
- 撤销当前用户全部会话（被盗 token 一次性失效）。

#### POST /api/auth/change-password
- 请求体：`{ "oldPassword": string, "newPassword": string }`（新密码 ≥ 6 位）。
- 原密码错误 → `401 { "error": "原密码错误" }`。
- 成功：`{ "success": true }`；改密后**撤销全部会话**（包括本次请求的 token）。

### 2.2 课程与判分 `routes/courses.js`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/courses` | 无 | 课程树索引（含各单元元数据） |
| GET | `/api/courses/progress` | 登录 | 当前用户全部课程进度 |
| GET | `/api/courses/:courseId` | 无 | 单门课程详情 |
| GET | `/api/courses/:courseId/units/:unitId` | 无 | 单元 + 各课元数据（**不含**节点内容） |
| GET | `/api/courses/:courseId/units/:unitId/lessons/:lessonId` | 登录 | 完整一课（**含答案键**，故登录门） |
| POST | `/api/courses/:courseId/units/:unitId/lessons/:lessonId/complete` | 登录 | 服务端判分 + 奖励，落库 |

- 课程 id / 单元 id / 课 id 均须存在于 `backend/data/courses/index.json` 白名单（防路径穿越），不存在返回 `404 { "error": "..." }`。
- 课程内容**实时读盘**，改 JSON 刷新即生效，无需重启；索引变化（新增课程/单元）也会在下次请求时热加载。

#### POST /complete — 判分与奖励核心
- 请求体：
  ```json
  {
    "answers": [
      { "nodeId": "l1_intro_n1", "userAnswer": "正确" },
      { "nodeIndex": 0, "userAnswer": 30 }
    ],
    "client_request_id": "offline-sync-xxx-8to64chars-no-slash"   // 可选，幂等键
  }
  ```
  - 节点寻址：优先按 `nodeId`（全局唯一、稳定），旧客户端按 `nodeIndex` 兜底。
  - `userAnswer` 必须是标量（string/number/boolean/null），否则 `400`。
- **服务端判分**：逐节点用 `gradeNode` 重判，`gradeable` 为 false 时一律判错（**fail-closed**，客户端 `correct` 字段不被信任）。按题型取不同答案键（`answer`（fill_blank 主键）/ `acceptable_answers` / `correct_answer` / `options[].is_correct` / `pairs` / `correct_order` / `target_zone` / `correct_probes` / `correct_setup` / `dial_options[].is_correct` 等）。
- 通过线：**accuracy ≥ 80** 才算 pass；sub-80 不计首次完成（可重试仍拿全额首次奖励）。
- **红心门禁**：本次有错题且红心 ≤ 0 → `400 { "error": "红心不足，无法提交错题练习", "needsHearts": true }`（全对提交不消耗红心）。
- **幂等键**：`client_request_id`（8–64 字符、不含 `/`）。同一 (user, client_request_id) 重放返回**首次提交的完整响应**（`submission_receipts` 表，与奖励同事务写入），不重判、不重复发奖。回执 30 天自动清理。
- 响应（也是回执内容）：
  ```json
  {
    "progress": { "id":1, "lesson_id":"electrician_basics/u1_meter_basics/l1_intro", "completed":1, "score":4, "max_score":4, "accuracy":100, "completed_at":"...", "attempts":1 },
    "accuracy": 100,
    "rewards": {
      "xpEarned": 15, "coinsEarned": 5, "heartCost": 0,
      "heartReturned": false, "xpBoostTriggered": false,
      "repeat": false, "passed": true, "gradedServerSide": true
    },
    "mistakesCount": 0,
    "gameState": { ...全部 game_state 字段... }
  }
  ```
- 奖励规则（服务端唯一权威）：
  - 首次 pass：XP = `accuracy>=100 ? 15 : 12`（10 × 1.5 / 1.2）；金币 +5；红心 50% 概率 +1（未满上限）；满分 30% 概率触发 15 分钟 2× XP 加成。
  - 非 pass 但 ≥1 题答对：+2 XP 努力奖励；全空/全错：0 XP。
  - 每答错一题扣 1 红心（服务端扣，扣到 0 为止）。
  - 每日 XP 上限 150（`game_state.daily_xp`，按上海日重置，超出部分截断为 0）。
  - `completed` 单调：**已 pass 过的课不会被 sub-80 重试降回未完成**（防 pass/fail 交替重复领奖）。

### 2.3 游戏状态与复习 `routes/game.js`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/game/state` | 登录 | 游戏状态（金币/经验/红心/段位/签到） |
| POST | `/api/game/use-heart` | 登录 | 消耗 1 红心（复习进入）；红心 ≤0 → 400 `{ error, canPractice:true }` |
| POST | `/api/game/restore-heart` | 登录 | 免费补 1 心（15 分钟冷却；冷却中 429 带 `retryAfterMs`） |
| POST | `/api/game/practice-heal` | 登录 + 限流 | 用「复习信用」兑红心与金币 |
| GET | `/api/game/mistakes` | 登录 | 到期错题队列（SM-2 调度，**答案已脱敏**） |
| GET | `/api/game/mistakes/due-count` | 登录 | 今日到期错题数 |
| POST | `/api/game/mistakes/review` | 登录 + 限流 | 提交回忆结果，服务端重判 + SM-2 排程，**唯一揭示答案的接口** |
| POST | `/api/game/spend-coins` | 登录 | 商店购买（价格以服务端 `ITEM_CATALOG` 为准） |
| GET | `/api/game/leaderboard/:league` | 可选登录 | 段位周榜（前 10 + 幽灵填充） |
| GET | `/api/game/league/info` | 登录 | 我的段位明细（排名/升降区/距晋升 XP） |
| GET | `/api/game/league/history` | 登录 | 我近 N 周结算历史（默认 12，≤52） |
| POST | `/api/game/league/_admin/settle` | **管理** + 限流 | 结算某已完成周（`force` 仅限最新未结算周） |
| GET | `/api/game/streak` | 登录 | 签到状态（`needsCheckin`） |
| POST | `/api/game/checkin` | 登录 | 签到（连胜 + 金币，日结 10~100） |

#### GET /api/game/mistakes — 错题卡脱敏规则
- 队列分两层：到期复习（`review_count>0`，最久优先）＋ 今日新错（`review_count=0`），各带硬顶（复习 50 / 新错 20），`limit`(1–30，默认 10) + `offset` 翻页。
- **答案键在 GET 阶段一律剥离**：`correct_answer` / `answer` / `acceptable_answers` / `explanation` / `correct_order` / `options[].is_correct` / match 的 `pairs` / drag_drop 的 `target_zone`+`distractors` / simulation_dial 的 `is_correct` / simulation_probe 的 `correct_probes` / multimeter_challenge 的 `correct_setup`+`correct_display`。卡面只保留可凭知识作答的渲染输入。
- 响应：`{ "mistakes": [脱敏卡...], "dueCount": N }`。
- 多选题池（`lesson_id='exam/ms_pool'`）的错题卡**不复用池内规范 id**：每卡带 `remap_json`（池 id → 会话随机 `ms-xxxx`），重判时正确集随卡移动，脚本盲猜固定 id 无法刷分。

#### POST /api/game/mistakes/review
- 请求体：`{ "mistakeId": number, "userAnswer": string, "responseTimeMs?": number, "sessionId?": string }`（后两者仅作遥测入 `review_log`，不影响奖励）。
- 服务端按卡对应节点重判（错题卡主 → 普通课；`exam/ms_pool` → 池节点按 remap 重映射判分）。客户端 `correct` 字段**不被信任**。
- **唯一**在提交后返回正确答案：`correctAnswer`（非原始卡）。
- 判错 → 卡重新进入本会话立即再练（`relearnInSession:true`）；判对且未达标 → SM-2 推进（间隔阶梯 1/6/…，`ease` ≥1.3）；间隔 ≥21 天 → mastered 出队。
- 判对一次 → 记账 1 单位「复习信用」（按错题去重），由 `/practice-heal` 兑现（+1 心 / +10 币 每单位，单次最多兑 20 单位）。
- 孤儿卡（节点已从课程数据删除）→ 直接标记 mastered 出队（防「永无法 master」死锁）。
- 限流 30 次/15 分钟/(IP+用户)。

#### POST /api/game/spend-coins
- 请求体：`{ "itemId": "freeze_block" | "xp_boost_15" | "heart_pack" | "streak_shield" }`
- 价格以服务端 `lib/shop.js ITEM_CATALOG` 为准（200/300/350/150），**请求体带价无效**。
- 道具效果：`heart_pack` 红心补满；`xp_boost_15` 15 分钟 2×；`freeze_block` / `streak_shield` 计数 +1。
- 响应：`{ ...game_state, itemId, itemName, inventory: [{item_id, quantity}...] }`；库存按 (user,item) 累加。

#### GET /api/game/leaderboard/:league
- `league` ∈ `bronze / silver / gold / emerald / diamond`。
- 未登录或不在该段位：返回 `{ entries(前10+幽灵), league, week_start, week_ends_at, is_my_league:false, viewer_league, my_rank:null, my_xp:null }`。
- 带有效 token 且命中自己的段位：返回完整 `getLeagueInfo`（`is_my_league:true`）。
- 幽灵榜（`ghost_*`）为确定性生成、`is_ghost:true`，补齐小段位空位。

#### POST /api/game/league/_admin/settle
- 请求体：`{ "weekStart": "YYYY-MM-DD"?, "force": boolean }`（`weekStart` 缺省 = 上周）。
- **只允许结算已结束周**（`weekStart < 本周`），当前周拒绝。`force:true` 只允许重算「最新一条未结算周」，防止用旧周数据回滚用户当前段位。
- 结算结果：rank 落库 + 升降段（按段位规则表，小段位按实际人数等比缩放升降区）+ 写 `league_history`；全部在单事务内。
- 鉴权失败：503（未配 ADMIN_TOKEN）/ 403（口令错误）。

### 2.4 模拟考 `routes/exam.js`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/exam/start` | 登录 | 生成一场新模拟考 |
| POST | `/api/exam/submit` | 登录 | 服务端整卷判分 + 奖励 |
| GET | `/api/exam/history` | 登录 | 近 20 场会话记录 |

#### POST /api/exam/start
- 每场：**100 题**（60 判断 + 30 单选 + 10 多选）/ **45 分钟** / **80 分及格**。
- 题源：考证课程 `electrician_exam`（s1–s13）全部判断/单选节点随机抽样；多选从独立池 `backend/data/exam/multi_select.json`（39 题，选项 A–D 带 `is_correct`）随机取 10。
- **防作弊**：多选题选项顺序随机，且每个选项 id 重映射为会话随机 `ms-xxxx`（判分按 id 而非字母）；盲猜固定 2 选项子集的命中率约 1/6（4 选 2 中恰好正确对，`C(4,2)=6`），正确项分布非恒 `{A,B}` 后固定 id 命中率实际更低。
- 返回题面已脱敏（无 `is_correct`/`correct_answer`/`explanation` 等答案键），每题带 `index`。
- 每用户最多一场 live：开新场会 `expired` 旧场；完成/过期会话 30 天后自动清理（题面 ~32KB/场，防止表无限膨胀）。
- 响应：`{ sessionId, total:100, minutes:45, passScore:80, expiresAt, questions:[脱敏题] }`。
- 题库不足 100 → `500 { "error": "题库不足: 仅 N/100 题" }`。

#### POST /api/exam/submit
- 请求体：`{ "sessionId": string, "answers": [{ "index": number, "userAnswer": 标量 }] }`
- 会话不存在/非本人 → 404；已交卷 → 409（`会话已交卷`）；已过期 → 409（`会话已过期`）。
- 服务端整卷重判（`gradeNode`），`passed = score≥80 且未超时`。
- 奖励与落库**单事务**：错题入 SM-2 错题本（多选带 remap）、逐节点入 `node_results` 遥测（归属原课，供 p-value 统计）、状态翻 `completed`。
- 首日首 pass：+30 币；pass 非首场：+30 XP；有答对但未 pass：+2 XP；全空：0。
- 响应：`{ sessionId, score, total, passed, expired, xpEarned, coinEarned, passScore, results:[{index, correct, userAnswer, correctAnswer}] }`（**results 含整卷答案**，仅交卷后返回）。

### 2.5 错误格式与状态码

- 统一错误体：`{ "error": "人类可读信息" }`（必要时含 `needsHearts` / `retryAfterMs` 等补充字段）。
- 常见状态码：
  - `400` 参数缺失/格式错（含红心不足）
  - `401` 未登录或会话过期
  - `403` 管理口令错误/无权
  - `404` 资源不存在（含错题非本人）
  - `409` 用户名冲突 / 会话已交卷或已过期
  - `429` 限流（带 `Retry-After` 头与 `retryAfterMs`）
  - `500` 服务器内部错误（不回显内部细节）
  - `503` 未配置 `ADMIN_TOKEN`
- 未匹配的 `/api/*` → `404 { "error": "接口不存在" }`；全局错误处理返回 JSON，绝不泄漏栈/SQL 细节。

---

## 三、限流规则（`middleware/rate_limit.js`）

内存固定窗口限流，键形如 `scope:key`，每分钟清理过期桶、上限 1 万桶（防内存泄漏）。

| scope | 窗口 | 上限 | 键 | 作用于 |
| --- | --- | --- | --- | --- |
| `auth-ip` | 15 分钟 | 20 | IP | login、change-password |
| `register` | 15 分钟 | 5 | IP | register（独立收紧，压用户名枚举） |
| `login-user` | 15 分钟 | 5 | `IP\|用户名(小写)` | 单账号错误登录锁 |
| `login-user-global` | 15 分钟 | 20 | 用户名(小写) | 跨 IP 分布式撞库兜底 |
| `change-pw` | 15 分钟 | 10 | `IP\|用户名` | 改密原密码暴力 |
| `practice-heal` | 15 分钟 | 10 | `IP\|userId` | 复习兑奖 |
| `mistake-review` | 15 分钟 | 30 | `IP\|userId` | 错题复习 |
| `lesson-views` | 15 分钟 | 240 | IP | 完整一课（含答案键）——正常学习每会话只加载数十课，240/15min 挡住整库答案批量抓取 |
| `admin` | 15 分钟 | 30 | IP | 管理结算 |

- 命中返回 `429 { "error": "请求过于频繁，请稍后再试", "retryAfterMs }` + `Retry-After` 头。
- 环境变量 `DLG_RATE_MAX_<scope>` 可覆盖各桶上限（**仅测试用**，生产不设置）。
- 登录成功会清零 `login-user` 与 `login-user-global` 桶，避免真实用户被早前失败卡住。
- 注意：限流在**内存**中，进程重启即重置；单机/小规模部署够用。

---

## 四、幂等性与离线同步

- 仅 `/complete` 支持 `client_request_id` 幂等键（X02 离线队列）：重放同键返回首次响应，不重判、不重复发奖。
- 回执存 `submission_receipts`（与奖励同一事务），30 天后按用户清理。
- 键约束：8–64 字符、不含 `/`；不合法则按普通提交处理（不报错）。

---

## 五、与内容数据的关系

- 课程/单元/课内容存于 `backend/data/courses/**`（JSON），`index.json` 是课程树权威白名单；**判分答案键随内容 JSON 一起维护**。
- 多选池 `backend/data/exam/multi_select.json`：39 题，A–D 四选项带 `is_correct`；考试与错题卡均以此为源，但选项 id 会做会话级/卡片级重映射。
- 任何内容改动必须过 `scripts/validate_content.cjs`（0 ERROR）与 `scripts/grade_scan.cjs`（判分 100% 自洽）两道门禁，见《测试说明》。

> 关联文档：《数据库 schema》`docs/数据库schema.md`（各表字段与迁移）、《运维手册》`docs/运维手册.md`（环境变量全表 / 备份 / 探活）。
