# Changelog

## v1.0.1 (未发布) — C10 错题刷币链封死 + P0-2 守护加固

- **单实例守护 (P0-2)**：`dlg_server_guard.sh` / `dlg_tunnel_guard.sh` 加 pidfile + `kill -0` 存活校验（重复启动直接 exit 0，杜绝双 guard 各起一个 server 对 app.db 并发 WAL 写）；`server.js` 打开数据库前先做端口互斥探测（端口被占 ⇒ 已有实例 ⇒ 干净退出），并加 Node ABI 预检（`process.versions.modules !== 137` 时在 require better-sqlite3 之前干净 exit 1，避免 Node 20 段错误）；登录自启经注册表 `HKCU\...\CurrentVersion\Run` 落地（计划任务被本机组策略拒绝）；**每日 DB 备份 cron**（03:47 Asia/Shanghai → `backend/models/data/backups/`，`db.backup()` WAL 一致性快照，当日幂等）+ **升级前快照脚本** `scripts/backup_db.cjs`（带 ABI 预检）
- **多选池错题卡复习重映射**：ms_pool 错题卡入册时生成 `remap_json`（池选项 id `{A,B,C,D}` → 随机 `ms-xxxx`，旧卡首次复习兜底生成落库），`loadMistakeNode` 复习判分时应用——正确集合逐卡移动，盲猜池固定正确项 `["A","B"]` 从 100% 命中降为 ≈1/45，铸币路封死（`database.js` / `exam.js` / `game.js`）
- **错题卡脱敏扩展 5 类题型答案键**：GET /mistakes 不再外泄 `match.pairs`、`drag_drop.target_zone/distractors`、`simulation_dial.dial_options[].is_correct/is_wrong`、`simulation_probe.correct_probes`、`multimeter_challenge.correct_setup/correct_display`；multimeter 复习卡前端降级为服务端判分（MultimeterChallenge handleConfirm 无 correct_setup 时直接提交 setupStr）
- **practice-heal 事务化**：claim review_credit + 加心/加币原子化，杜绝「已 claim 未入账 / 重试双花」部分态
- **complete 红心门禁（P1 残留项收官）**：红心惩罚移入服务端——答错每题扣一心（扣到 0 为止）；红心已耗尽且本次有错题 → 400 `needsHearts` 拒绝提交，与 /game/use-heart「红心≤0 拒绝」一致；全对提交不消耗红心，红心 0 时仍可全对通过，不卡学习。`rewards.heartCost` 回传实际扣心数（`courses.js`）
- **测试门禁**：安全不变量 16→17（新增 complete 红心门禁：红心 0 拒错题 / 全对放行 / 答错扣心），smoke 适配红心门禁补心，总断言 102→103

## v1.0.0 (2026-08-14) — 首个公开版本

- **内容资产**：3 大课程 / 28 单元 / 703 微课 / 4,991 节点，覆盖电工零基础、初级理论、考证主线（安全与急救）
- **全真模拟考**：100 题（60 判断 + 30 单选 + 10 多选）/ 45 分钟 / 80 分及格，含历史成绩
- **服务端判分**：MC / TF / 填空 / 匹配 / 排序 / 万用表模拟 / 危险操作模拟，11 种节点类型全部可判
- **游戏化闭环**：金币 / 生命恢复 / 签到连击 / 段位排行榜 / 周结算（每周一 0:00 自动）
- **错题 SM-2**：错题自动入库，按间隔复习，复习奖励封顶不丢分
- **数据埋点**：`node_results` 逐节点正确率落库，支撑题库校准
- **测试门禁**：内容校验器 + 99 断言（接口 44 / 里程碑 20 / 排行榜 12 / 结算 10 / 安全不变量 13）+ 判分自洽扫描 3713 节点 100%
- **安全不变量回归**：错题卡脱敏缺席断言、register 独立桶边界、login-user-global 跨 IP 兜底、模拟考及格路径、多选选项 id 会话级重映射（防 `{A,B}` 盲刷）
- 首次公开发布：文档 / LICENSE / 公开仓库建立

## 里程碑回顾（内部开发阶段）

- **P0 地基**：鉴权体系 → 测试隔离 → 判分回归 → 结算事务 → 奖励闭环 → 错题 SM-2 → 内容硬错误修复 → 内容 CI 校验
- **P0 D 埋点**：`node_results` 逐节点遥测（此前正确题数据全丢，无法算难度）
- **P0 F SM-2**：孤儿错题卡 dismiss + 复习额度封顶不丢弃
- **P0 G 内容校正**：AC 使用类别 / 两线三线控制 / 低压阈值等补题 + 判分回归
- **P1 价值锚**：全真模拟考引擎上线
- **P1 内容扩容**：考证主线 13 单元（s1~s13）全部落地；u6/u7 扩题；u8~u11 钻练习墙重切微课（25→75 课等）
- **P1 大纲缺口**：起始方式对比、五大高频板块对标（负荷计算 / 布线工艺）、GFCI vs RCD、接触器选型计算、符号标准五项收官
