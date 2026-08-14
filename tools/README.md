# 🛠️ 开发工具

本项目把开发过程中产生的一次性脚本与工具集中在这里，与运行时代码分离。

## `legacy/` — 历史开发脚本（仅供参考）

这些脚本是内容建设/调试过程中的一次性工具，**不参与运行、不参与 `npm test`**：

- `append_ids.js` / `fix_*.cjs` — 早期内容结构修复脚本
- `export_courses.js` / `fill_match_pairs.cjs` — 课程导出与填空题配对工具
- `audit_explanations.cjs` — 解释文本审计
- `test_*.mjs / *.cjs / *.js` — 历史测试脚本（当前测试套件见根目录 `test_api.mjs` 等，由 `npm test` 驱动）

保留它们仅为归档参考；新改动请遵循当前 `docs/` 与 `scripts/` 的规范。

## `../scripts/` — 当前内容工具链（会跑）

- `validate_content.cjs` — 内容校验器（发布门禁，`npm test` 第一步）
- `check_data_integrity.cjs` / `cleanup_data_hygiene.cjs` — 数据体检 / 清理
- `fix_tf_alltrue.cjs` / `fix_transcription_commentary.cjs` — 内容修复
- `normalize_multimeter_display.mjs` — 万用表读数显示规范化

## `../parser/` — 讲义→内容转换工具

把外部讲义素材（如课程字幕/文稿）转换为 `backend/data/courses/` 下的结构化 JSON。
`parser/chunks/` 存放转换中间产物，**不随仓库发布**（已 gitignore），转换后请自行清理。
