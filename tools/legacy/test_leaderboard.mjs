// 排行榜运行时测试 — 已被 test_leaderboard_v2.mjs 取代。
// 本文件历史上针对旧 API(auth 免 token / add-coins / leaderboard 裸数组)撰写，
// 会产出过时的假 bug 报告(如「无 cron」「无晋升」——现均已实现)。
// 保留文件名以便旧脚本习惯，实际执行 v2 权威套件。
'use strict';
await import('./test_leaderboard_v2.mjs');
