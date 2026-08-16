import { describe, it, expect, vi } from 'vitest';
import { getToken, setToken, onUnauthorized, api } from './api';

// ── fetch mock 辅助 ────────────────────────────────────────────────────────────
function mockFetchOnce(status, body) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api token 存取', () => {
  it('setToken 写入、getToken 读回、null 清除', () => {
    expect(getToken()).toBeNull();
    setToken('abc123');
    expect(getToken()).toBe('abc123');
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe('api 401 全局兜底（P32 P2-3）', () => {
  it('用户域端点 401 → 触发 onUnauthorized 处理器', async () => {
    const fn = vi.fn();
    onUnauthorized(fn);
    mockFetchOnce(401, { error: '未登录或会话已过期' });
    await expect(api.getMe()).rejects.toThrow('未登录或会话已过期');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('多个处理器都被触发', async () => {
    const a = vi.fn();
    const b = vi.fn();
    onUnauthorized(a);
    onUnauthorized(b);
    mockFetchOnce(401, { error: 'x' });
    await api.getGameState().catch(() => {});
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('业务 401（login/change-password 错误口令）不触发处理器', async () => {
    const fn = vi.fn();
    onUnauthorized(fn);
    mockFetchOnce(401, { error: '用户名或密码错误' });
    await api.login('u', 'bad').catch(() => {});
    expect(fn).not.toHaveBeenCalled();
  });

  it('退订后不再触发', async () => {
    const fn = vi.fn();
    const unsub = onUnauthorized(fn);
    unsub();
    mockFetchOnce(401, { error: 'x' });
    await api.getMe().catch(() => {});
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('api 请求与错误面', () => {
  it('带 token 时附 Authorization Bearer 头', async () => {
    setToken('tok-xyz');
    const fn = mockFetchOnce(200, { ok: true });
    await api.getMe();
    const [, opts] = fn.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer tok-xyz');
  });

  it('无 token 时不带 Authorization 头', async () => {
    const fn = mockFetchOnce(200, { ok: true });
    await api.getCourses();
    const [, opts] = fn.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('服务端 needsHearts 冒到错误对象（offlineQueue 依赖）', async () => {
    mockFetchOnce(400, { error: '红心不足，无法提交错题练习', needsHearts: true });
    const err = await api.completeLesson('c', 'u', 'l', { answers: [] }).catch(e => e);
    expect(err.status).toBe(400);
    expect(err.needsHearts).toBe(true);
  });

  it('非 2xx 抛错，错误消息取服务端 error 字段', async () => {
    mockFetchOnce(404, { error: '资源不存在' });
    await expect(api.getCourse('nope')).rejects.toThrow('资源不存在');
  });
});
