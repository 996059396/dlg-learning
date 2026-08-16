# Changelog

## v1.0.2 (未发布) — docs 四大件 + e2e 鉴权修复 + 数据卫生

- **docs 四大件收官（#98）**：`docs/API.md`（接口全契约）/ `docs/数据库schema.md`（13 表 + 迁移策略）/ `docs/课程设计.md`（3 课程 704 课时 / 5020 节点、13 题型分布、知识图谱 586 条汇总、引用链 137 条）/ `docs/运维手册.md`（单实例约束、env 全表、备份回滚、升级流程）。40 项标准号联网核验（openstd.samr.gov.cn / IEC webstore），勘误 17 处，含两处硬错误：**GB 13398-2008 实为绝缘管棒标准（验电器应为 DL/T 740-2014）**、**GB/T 13870.1 现行为 2022 版**。
- **多选池扩至 39（#97）**：`multi_select.json` 10→39 题，覆盖考证 8 条知识点线；正确项分布不再恒 `{A,B}`。`grade_scan` 期望值同步 3742 节点。
- **断言数校正 102→109**：结算 10→14、安全不变量 16→19（CLAUDE.md / README / 快速开始 / 内容结构 / 测试说明 同步）。
- **浏览器 e2e 注入鉴权（#100）**：`test_answer_feedback.mjs` / `test_truefalse_fix.mjs` 在 X08 身份门后全部失效，现复用 `e2e_helpers.injectAuth` 注册注入 token + 前端进度预解锁；MC 正确项改从认证 lesson API 动态解析（内容轮换不再失效）。6/6 + 3/3 全绿。
- **live 数据卫生（#99）**：`check_data_integrity.cjs` 新增**重复错题卡检查**（抓出 live 库 5 对重复卡）；`scripts/cleanup_live_test_data.cjs`（幂等、备份优先）清掉 22 个测试用户（e2e_/mm_e2e_/v10*/v22*/x05_*）及全部依赖行，live 仅剩演示用户「小电工」。
- **公开仓快照脚本化（#99）**：`scripts/sync_public_snapshot.cjs` 固化「git archive + 排除清单 + 镜像 + push」流程，排除 71 项内部/版权物；脚本自身不入公开仓（避免暴露内部文件名）。
- **测试门禁**：全量 109 断言 + 判分 3742 节点 100% + canary 704 课时零孤儿全绿（Node 24）。

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
