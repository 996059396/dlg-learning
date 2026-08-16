# 🗄️ 数据库 Schema

单文件 SQLite（better-sqlite3 v13）。所有建表/迁移集中在 `backend/models/database.js` 的 `initializeDatabase()`；模拟考表 `exam_sessions` 在 `backend/routes/exam.js` 模块加载时幂等建表。

- 数据库文件：`backend/models/data/app.db`（`DLG_DB_PATH` 可覆盖，测试用它隔离库）
- 模式：`journal_mode = WAL`（并发读写）；`foreign_keys = ON`
- **`app.db` 含真实用户密码哈希，已被 `.gitignore` 排除，切勿提交/上传**。备份见 `docs/运维手册.md`。
- 时间口径：业务上的「今天/周」一律 Asia/Shanghai；`CURRENT_TIMESTAMP`（SQLite 内建）为 UTC。

---

## 一、表关系总览

```
users 1 ── n sessions            (用户 ── 会话)
users 1 ── 1 game_state          (用户 ── 游戏状态)
users 1 ── n progress            (用户 ── 课程进度)
users 1 ── n mistakes            (用户 ── 错题本)
mistakes 1 ── n review_log       (错题 ── 复习历史, 追加式)
mistakes 1 ── n review_credit    (错题 ── 复习信用, UNIQUE 去重)
users 1 ── n inventory           (用户 ── 道具库存)
users 1 ── n leaderboard         (用户 ── 每周排行快照)
users 1 ── n league_history      (用户 ── 每周段位历史)
users 1 ── n node_results        (用户 ── 逐节点作答遥测)
users 1 ── n submission_receipts (用户 ── 幂等回执)
users 1 ── n exam_sessions       (用户 ── 模拟考会话)
```

---

## 二、表定义

### users

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | UUID（`uuidv4`） |
| username | TEXT | NOT NULL, **UNIQUE**(迁移建索引) | NFKC 归一化，≤24 字符 |
| password_hash | TEXT | 可空 | `salt:scrypt64hex`，**绝不存明文**；遗留无密码账号此列为 NULL |
| avatar | TEXT | DEFAULT 'default' | 头像 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | UTC |
| last_login | DATETIME | DEFAULT CURRENT_TIMESTAMP | 登录时更新 |

- 唯一索引 `idx_users_username ON users(username)`：`CREATE UNIQUE INDEX IF NOT EXISTS`，对已有重复的旧库会失败（register 路由有应用层预查兜底）。

### sessions

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| token_hash | TEXT | PK | token 的 SHA-256 hex（**不存原始 token**） |
| user_id | TEXT | NOT NULL, FK→users | |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 用于 90 天绝对上限 |
| expires_at | DATETIME | NOT NULL | 滑动续期：30 天；请求时自动续（≥1h 才写），上限自创建 90 天 |

### game_state

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| user_id | TEXT | PK, FK→users | |
| hearts | INTEGER | DEFAULT 5 | 当前红心 |
| max_hearts | INTEGER | DEFAULT 5 | 红心上限 |
| coins | INTEGER | DEFAULT 500 | 金币 |
| xp | INTEGER | DEFAULT 0 | 总经验 |
| streak | INTEGER | DEFAULT 0 | 签到连胜 |
| last_streak_date | TEXT | | `YYYY-MM-DD`（上海） |
| league | TEXT | DEFAULT 'bronze' | 段位：bronze/silver/gold/emerald/diamond |
| league_rank | INTEGER | DEFAULT 0 | 预留 |
| xp_boost_multiplier | REAL | DEFAULT 1.0 | 经验加成倍率 |
| xp_boost_until | TEXT | | 加成截止 ISO（过期按 1.0 算） |
| freeze_item_count | INTEGER | DEFAULT 0 | 连胜冷冻块库存计数 |
| streak_shield_count | INTEGER | DEFAULT 0 | 连胜护盾计数（**迁移列**） |
| daily_xp | INTEGER | DEFAULT 0 | 当日已获课程 XP（**迁移列**，上限 150） |
| daily_xp_date | TEXT | | 记录所属上海日（**迁移列**） |
| last_heart_restore | TEXT | | 免费补心冷却时间（**迁移列**，15 分钟） |

### progress

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL, FK→users | |
| lesson_id | TEXT | NOT NULL | `courseId/unitId/lessonId` |
| completed | BOOLEAN | DEFAULT 0 | **单调**：曾 pass 即保持 1 |
| score | INTEGER | DEFAULT 0 | 答对题数 |
| max_score | INTEGER | DEFAULT 0 | 总判分题数 |
| accuracy | REAL | DEFAULT 0 | 正确率 % |
| completed_at | DATETIME | | |
| attempts | INTEGER | DEFAULT 0 | 提交次数 |

- 约束：`UNIQUE(user_id, lesson_id)`。

### mistakes（SM-2 错题本）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL, FK→users | |
| lesson_id | TEXT | NOT NULL | 归属课；多选池用 `exam/ms_pool` |
| node_index | INTEGER | NOT NULL | 遗留寻址（node_id 出现前） |
| node_id | TEXT | 可空（迁移列） | **稳定寻址主键**（节点全局唯一 id） |
| question_text | TEXT | | 题目快照 |
| user_answer | TEXT | | 错时答案快照 |
| correct_answer | TEXT | | 正确答案快照（**GET 不返回，仅 review 后揭示**） |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | |
| reviewed | BOOLEAN | DEFAULT 0 | 是否已复习过 |
| easiness | REAL | DEFAULT 2.5 | SM-2 EF（迁移列） |
| interval_days | INTEGER | DEFAULT 0 | SM-2 当前间隔（迁移列） |
| review_count | INTEGER | DEFAULT 0 | 成功复习次数（迁移列） |
| next_review_date | TEXT | | `YYYY-MM-DD`（上海），到期 ≤ today 才入队（迁移列；旧行回填为当天） |
| mastered | BOOLEAN | DEFAULT 0 | interval ≥21 天 或孤儿卡 dismiss（迁移列） |
| remap_json | TEXT | | 多选池错题卡的选项 id 重映射 `{池id: 随机ms-xxxx}`（C10，迁移列） |

- 索引：
  - `idx_mistakes_user_due ON mistakes(user_id, mastered, next_review_date)`（队列查询）
  - `idx_mistakes_user_node ON mistakes(user_id, lesson_id, node_id)`（addMistake 存在性检查 / 完整性校验）

### review_credit（复习信用）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL, FK→users | |
| mistake_id | INTEGER | NOT NULL | 无 FK 声明（应用层维护；全仓无 `REFERENCES mistakes`） |
| claimed | INTEGER | DEFAULT 0 | 是否已兑现 |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | |

- 约束：`UNIQUE(user_id, mistake_id)`（同一错题最多记 1 单位信用）。
- 兑现：`claimReviewCredit` 用带自引用子查询的原子 UPDATE 防止并发双兑。

### review_log（复习历史，追加式）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL, FK→users | |
| mistake_id | INTEGER | NOT NULL | 无 FK 声明（应用层维护；全仓无 `REFERENCES mistakes`） |
| reviewed_at | TEXT | NOT NULL | 完整 ISO 时间戳（可度量留存，非仅日期） |
| quality | INTEGER | NOT NULL | SM-2 质量（判对 4 / 判错 2） |
| correct | INTEGER | NOT NULL | 服务端判定结果 |
| response_time_ms | INTEGER | | 遥测（不入奖励） |
| interval_before / interval_after | INTEGER | | 排程前后间隔 |
| ease_before / ease_after | REAL | | 排程前后 EF |
| session_id | TEXT | | 遥测会话标识 |

- 索引：`idx_review_log_user_time ON review_log(user_id, reviewed_at)`。
- 每次 `reviewMistake` 状态更新 + log 追加 + 信用记入**同一事务**。

### inventory

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL, FK→users | |
| item_id | TEXT | NOT NULL | `freeze_block/xp_boost_15/heart_pack/streak_shield` |
| quantity | INTEGER | DEFAULT 1 | 购买累加 |

- 约束：`UNIQUE(user_id, item_id)`（旧库无该约束时启动时重建表）。

### leaderboard（每周排行快照）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL, FK→users | |
| week_start | TEXT | NOT NULL | `YYYY-MM-DD`（上海周一） |
| xp_earned | INTEGER | DEFAULT 0 | 该周已获经验（addXP 累加） |
| league | TEXT | DEFAULT 'bronze' | 结算时所在的段位 |
| final_rank | INTEGER | 迁移列 | 结算定级 |
| tier_change | TEXT | 迁移列 | promoted / demoted / stay / champion |
| reward_claimed | INTEGER | DEFAULT 0 | 迁移列 |
| settled_at | DATETIME | 迁移列 | 已结算时间戳（NULL=未结算） |

- 约束：`UNIQUE(user_id, week_start)`（旧库无该约束时启动时重建表）。
- 索引：`idx_lb_week_league_xp(week_start, league, xp_earned DESC)`、`idx_lb_user_week(user_id, week_start)`。

### league_history（个人周段位历史）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL | 无 FK 声明（应用层维护） |
| week_start | TEXT | NOT NULL | |
| league_from | TEXT | | 原段位 |
| league_to | TEXT | | 结算后段位 |
| final_rank | INTEGER | | |
| xp_earned | INTEGER | | |
| result | TEXT | | champion / promoted / demoted / stay |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | |

- 约束：`UNIQUE(user_id, week_start)`（`INSERT OR REPLACE` 幂等回填）。

### node_results（逐节点遥测，p-value 数据源）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK AUTOINCREMENT | |
| user_id | TEXT | NOT NULL | 无 FK 声明（应用层维护） |
| lesson_id | TEXT | NOT NULL | 归属课（考试遥测归原课，`exam/ms_pool` 归池） |
| node_id | TEXT | NOT NULL | 题目 id |
| node_type | TEXT | NOT NULL | 题型 |
| question_text | TEXT | | 题目快照（内容后续编辑不影响统计） |
| correct | INTEGER | NOT NULL | 服务端判定 |
| user_answer | TEXT | | 原答案 |
| lesson_accuracy | INTEGER | NOT NULL | 当次课正确率 % |
| created_at | TEXT | NOT NULL | `YYYY-MM-DD`（上海） |

- 索引：`idx_node_results_lesson_node(lesson_id, node_id)`、`idx_node_results_node(node_id)`。
- `getNodeStats(lessonId)` 按 `(lesson_id, node_id)` 聚合正确率（p-value），支撑题库校准（P0 G）。

### submission_receipts（幂等回执）

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| user_id | TEXT | NOT NULL, FK→users | |
| client_request_id | TEXT | NOT NULL | 离线同步幂等键（8–64 字符、无 `/`） |
| response_json | TEXT | NOT NULL | 首次提交的完整响应（奖励快照） |
| created_at | DATETIME | DEFAULT CURRENT_TIMESTAMP | 用于 30 天清理 |

- 主键：`(user_id, client_request_id)`。

### exam_sessions（模拟考会话）

> 建表在 `routes/exam.js` 模块加载时（`CREATE TABLE IF NOT EXISTS`），不参与 `database.js` 初始化。

| 列 | 类型 | 约束/默认 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | `crypto.randomBytes(8).toString('hex')` |
| user_id | INTEGER | NOT NULL | ⚠️ 代码实际为 `INTEGER`（users.id 是 TEXT UUID，类型不匹配，故**无 FK 声明**——弱类型缺口，已记录） |
| started_at | TEXT | NOT NULL | ISO |
| expires_at | TEXT | NOT NULL | start + 45 分钟 |
| status | TEXT | DEFAULT 'active' | active / completed / expired |
| score | INTEGER | | 交卷后填充 |
| total | INTEGER | | 100 |
| passed | INTEGER | | 0/1 |
| questions_json | TEXT | NOT NULL | 整卷题面（~32KB，会话随机选项 id 已内嵌） |
| answers_json | TEXT | | 交卷答案 |
| created_at | DATETIME | DEFAULT (datetime('now')) | 30 天清理依据（UTC） |

- 索引：`idx_exam_sessions_user ON exam_sessions(user_id, started_at)`。
- 每用户至多一场 live：开新场置旧场 expired；完成/过期 30 天后删除。

---

## 三、迁移策略

`initializeDatabase()` 的迁移模式：

1. `CREATE TABLE IF NOT EXISTS` 建齐所有表（含新表应有的列）。
2. **迁移列**（老库升级补列）：读 `PRAGMA table_info(...)`，缺列则 `ALTER TABLE ... ADD COLUMN ...`（`try/catch` 吞重复）。迁移列清单：leaderboard(final_rank/tier_change/reward_claimed/settled_at)、users.password_hash、mistakes.node_id、game_state(streak_shield_count/daily_xp/daily_xp_date/last_heart_restore)、mistakes(easiness/interval_days/review_count/next_review_date/mastered/remap_json)。
3. 补 `CREATE UNIQUE INDEX IF NOT EXISTS`（users.username）——旧库已有重复会失败并 warn，靠应用层兜底。
4. **重建表加约束**：SQLite 的 `IF NOT EXISTS` 不给既有表加 UNIQUE。对 `inventory`、`leaderboard` 检查 `sqlite_master` 的建表 SQL，缺 `UNIQUE(...)` 则「建新表 → INSERT OR IGNORE 拷贝 → DROP 旧表 → RENAME」。
5. 数据回填：错题 `next_review_date IS NULL` → 回填上海今天（立即到期）。
6. 首启建默认用户「小电工」。

**升级提示**：新增可空列优先走 ADD COLUMN（免重建）；新增 UNIQUE 约束必须走重建流程；跑迁移前先备份（`scripts/backup_db.cjs`）。

---

## 四、数据安全红线

- `users.password_hash` 只在本仓库被 `SELECT *` 时显式排除（`getUser` 用显式列，绝不 `u.*`）；任何新查询**不得**无差别返回 `users.*`。
- `sessions.token_hash` 存哈希，原始 token 只在签发瞬间存在于响应体。
- 备份目录 `backend/models/data/backups/*.db` 与 `app.db*`（含 `-wal`/`-shm`）均被 `.gitignore` 排除。
- 破坏性操作（清表/删用户/回滚）必须先快照备份，见 `docs/运维手册.md` §备份与回滚。

> 关联文档：接口契约 `docs/API.md`、内容结构 `docs/内容结构.md`、运维 `docs/运维手册.md`。
