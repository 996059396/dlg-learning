// 学习分析指标端点（crosscheck6 F 方向 3「学习数据服务」落地）：
//   GET /api/metrics/hardest-nodes  —— 全库最难题（聚合 p-value，供内容校准/冲刺卷组卷）
//   GET /api/metrics/me             —— 当前用户自己的作答统计（attempts/正确率/错题数）
// 数据源 node_results（P0-D 埋点：complete/exam 逐节点落库，此前仅 getNodeStats 无路由调用）。
const express = require('express');
const db = require('../models/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// 全库最难题：按 (node, lesson) 聚合正确率升序，取最低的 N 个（难度代理）。
// 需登录（聚合数据揭示内容使用分布，不当匿名暴露）。
router.get('/hardest-nodes', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const rows = db.getHardestNodes(limit);
  res.json({ nodes: rows, total: rows.length });
});

// 当前用户自己的统计（仅本人可见——requireAuth 用 token 推导 user_id，不信任客户端）。
router.get('/me', requireAuth, (req, res) => {
  const stats = db.getUserNodeStats(req.userId) || { attempts: 0, pct_correct: null, mistakes: 0, lessons_touched: 0 };
  // 按课聚合的薄弱排行，供「我的薄弱项」。
  const byLesson = db.getUserLessonsStats(req.userId);
  res.json({ ...stats, byLesson });
});

module.exports = router;
