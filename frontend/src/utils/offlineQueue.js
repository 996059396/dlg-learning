// X02 离线完成队列
//
// 离线完成一堂课时，前端不能提交给服务端（会拿到 401 以外的网络错误），于是把
// raw answers + client_request_id 存进 localStorage，联网后重放。服务端按
// (user_id, client_request_id) 幂等（见 routes/courses.js 的 submission_receipts）：
// 重放返回首次的响应、绝不二次判分/二次铸币 —— 这正是「奖励入队重连同步」不会
// 重开「self-report 100% 铸币」漏洞的根基（奖励仍只在服务端铸）。
//
// 关键点：
//  - 队列按 userId 分桶，只 flush 当前登录用户的条目，登出换号不串；
//  - 2xx 移除；4xx（永久失败，如红心不足）保留为 blocked 态，不自动重试也不丢弃；
//    网络错误/5xx 保留 pending 态，下次上线自动重试；
//  - 条目数上限 QUEUE_MAX，超出丢最旧的 pending（离线只是兜底，不该无限堆积）。

import { api } from './api';

const QUEUE_KEY = 'dlg_offline_queue';
const QUEUE_MAX = 20;

function genClientRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // 老浏览器兜底（不要求密码学强度，只要求唯一）。
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function readQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function writeQueue(q) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch (e) {
    console.error('[offlineQueue] 写入失败:', e);
  }
}

// 入队一条离线完成的课程。entry: { userId, courseId, unitId, lessonId, answers, localRewards }。
export function enqueueOfflineCompletion(entry) {
  const q = readQueue();
  q.push({
    client_request_id: genClientRequestId(),
    status: 'pending',
    attempts: 0,
    error: null,
    queuedAt: new Date().toISOString(),
    ...entry,
  });
  // 上限：丢最旧的 pending，但保留 synced/blocked 记录（它们只是状态存档）。
  const pendingIdx = q.findIndex((e) => e.status === 'pending');
  const overflow = q.filter((e) => e.status === 'pending').length - QUEUE_MAX;
  if (overflow > 0) {
    const drop = q
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e.status === 'pending')
      .sort((a, b) => (a.e.queuedAt || '').localeCompare(b.e.queuedAt || ''))
      .slice(0, overflow)
      .map((x) => x.i);
    drop.sort((a, b) => b - a);
    for (const i of drop) q.splice(i, 1);
  }
  writeQueue(q);
  return q;
}

export function getQueueLength() {
  return readQueue().length;
}

// 供 UI 显示 pending 数量（例如离线状态的角标）。
export function getPendingCount(userId) {
  return readQueue().filter((e) => e.userId === userId && e.status === 'pending').length;
}

// 把指定用户（当前登录）的 pending 条目重放给服务端。返回 { synced, blocked, failed, total }。
//  - synced:  服务端接受（含幂等重放返回的缓存响应）→ 标记 synced；
//  - blocked: 4xx 且非重试可解（红心不足需要用户操作）→ 标记 blocked 保留；
//  - failed:  网络/5xx → 保留 pending 下次重试。
// 只 flush 传入 userId 的条目：登出换号后，旧用户的离线成绩绝不拿新 token 去提交。
export async function flushOfflineQueue(userId) {
  const q = readQueue();
  const pending = q.filter((e) => e.userId === userId && e.status === 'pending');
  if (!pending.length) return { synced: 0, blocked: 0, failed: 0, total: 0 };

  let synced = 0;
  let blocked = 0;
  let failed = 0;
  for (const entry of pending) {
    try {
      const res = await api.completeLesson(entry.courseId, entry.unitId, entry.lessonId, {
        answers: entry.answers,
        client_request_id: entry.client_request_id,
      });
      entry.status = 'synced';
      entry.syncedAt = new Date().toISOString();
      entry.result = { accuracy: res.accuracy, rewards: res.rewards };
      entry.error = null;
      synced++;
    } catch (e) {
      const status = e && e.status;
      if (status === 400 && e.needsHearts) {
        // 服务端红心门禁：和在线提交一致 —— 红心不足时离线成绩不能入库。
        // 保留为 blocked，等用户恢复红心后手动/下次上线再试，不丢弃不反复刷。
        entry.status = 'blocked';
        entry.error = '红心不足，离线成绩待恢复红心后同步';
        blocked++;
      } else if (status === 401) {
        // 会话失效（在别的设备登出/改密）：不是提交被拒。保留 pending，等用户
        // 重新登录（user 变化会触发再次 flush）用新 token 重试。
        entry.attempts = (entry.attempts || 0) + 1;
        entry.error = '登录状态已失效，重新登录后自动同步';
        failed++;
      } else if (status >= 400 && status < 500) {
        entry.status = 'blocked';
        entry.error = e.message || `HTTP ${status}`;
        blocked++;
      } else {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.error = e?.message || String(e);
        failed++;
      }
    }
  }
  writeQueue(q);
  return { synced, blocked, failed, total: pending.length };
}
