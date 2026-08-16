import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueOfflineCompletion, readQueue, getPendingCount, flushOfflineQueue } from './offlineQueue';
import { api } from './api';

beforeEach(() => {
  vi.restoreAllMocks();
});

function entry(lessonId, userId = 'userA') {
  return { userId, courseId: 'c', unitId: 'u', lessonId, answers: [{ nodeId: 'n1', userAnswer: 1 }] };
}

describe('offlineQueue 入队', () => {
  it('入队生成 client_request_id + pending 状态', () => {
    enqueueOfflineCompletion(entry('l1'));
    const q = readQueue();
    expect(q).toHaveLength(1);
    expect(q[0].status).toBe('pending');
    expect(q[0].client_request_id).toBeTruthy();
  });

  it('上限 20：超出丢最旧 pending，保 20 条', () => {
    for (let i = 1; i <= 25; i++) enqueueOfflineCompletion(entry(`l${String(i).padStart(2, '0')}`));
    const q = readQueue();
    expect(q).toHaveLength(20);
    expect(q.every(e => e.status === 'pending')).toBe(true);
    // 最旧 5 条（l01..l05）被丢，最新的 l06..l25 保留（Array.sort 稳定，等时戳保序）。
    const lessonIds = q.map(e => e.lessonId);
    expect(lessonIds[0]).toBe('l06');
    expect(lessonIds[19]).toBe('l25');
  });

  it('getPendingCount 按用户过滤', () => {
    enqueueOfflineCompletion(entry('l1', 'userA'));
    enqueueOfflineCompletion(entry('l2', 'userA'));
    enqueueOfflineCompletion(entry('l1', 'userB'));
    expect(getPendingCount('userA')).toBe(2);
    expect(getPendingCount('userB')).toBe(1);
  });
});

describe('offlineQueue flush 状态机', () => {
  it('2xx→synced / 红心400→blocked / 401→pending / 网络错→pending / 其他4xx→blocked', async () => {
    const outcomes = [
      { t: 'ok' },
      { t: 'hearts' },
      { t: 'unauth' },
      { t: 'network' },
      { t: 'perm' },
    ];
    let call = 0;
    vi.spyOn(api, 'completeLesson').mockImplementation(async () => {
      const o = outcomes[call++];
      if (o.t === 'ok') return { accuracy: 100, rewards: {} };
      const e = new Error(o.t);
      if (o.t === 'hearts') { e.status = 400; e.needsHearts = true; }
      else if (o.t === 'unauth') e.status = 401;
      else if (o.t === 'perm') e.status = 422;
      throw e;
    });
    for (let i = 1; i <= 5; i++) enqueueOfflineCompletion(entry(`l${i}`));

    const r = await flushOfflineQueue('userA');
    expect(r).toEqual({ synced: 1, blocked: 2, failed: 2, total: 5 });

    const statuses = readQueue().map(e => e.status);
    expect(statuses).toEqual(['synced', 'blocked', 'pending', 'pending', 'blocked']);
  });

  it('只 flush 指定 userId（换号不串）', async () => {
    vi.spyOn(api, 'completeLesson').mockResolvedValue({ accuracy: 100, rewards: {} });
    enqueueOfflineCompletion(entry('l1', 'userA'));
    enqueueOfflineCompletion(entry('l1', 'userB'));
    await flushOfflineQueue('userA');
    const statuses = readQueue().map(e => `${e.userId}:${e.status}`);
    expect(statuses).toEqual(['userA:synced', 'userB:pending']);
  });

  it('无 pending 时短路返回', async () => {
    const r = await flushOfflineQueue('ghost');
    expect(r).toEqual({ synced: 0, blocked: 0, failed: 0, total: 0 });
  });
});
