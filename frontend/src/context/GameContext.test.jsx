// @vitest-environment jsdom
// GameContext boot 状态机组件测试（crosscheck5 X H6）：
//   - 无 token → 进登录门（needsAuth）
//   - getMe 401 → 清 token + 进登录门
//   - 网络错误 + 有缓存身份 → 恢复真实身份 + offline（X02 离线学习）
//   - 网络错误 + 无缓存 → demo 降级 + offline（且必须显式、不能白屏——Layout critical 回归由
//     此守卫：离线横幅引用未声明变量会在渲染时抛错，render 即红）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { GameProvider, useGame } from './GameContext';

afterEach(cleanup); // vitest 未开 globals，testing-library 不会自动卸载 DOM

let getMeImpl = async () => { throw new Error('no impl'); };
let handlers = [];

vi.mock('../utils/api', () => ({
  api: {
    getMe: (...a) => getMeImpl(...a),
    getGameState: async () => { throw new Error('not mocked'); },
  },
  getToken: () => localStorage.getItem('dlg_token'),
  setToken: (t) => { if (t) localStorage.setItem('dlg_token', t); else localStorage.removeItem('dlg_token'); },
  onUnauthorized: (fn) => { handlers.push(fn); return () => { handlers = handlers.filter(h => h !== fn); }; },
}));
vi.mock('../utils/offlineQueue', () => ({ flushOfflineQueue: async () => ({ synced: 0, blocked: 0, failed: 0, total: 0 }) }));

function Probe() {
  const { user, offline, needsAuth, loading } = useGame();
  return <div data-testid="probe">{JSON.stringify({ user: user?.id ?? null, offline, needsAuth, loading })}</div>;
}
function state() { return JSON.parse(screen.getByTestId('probe').textContent); }

describe('GameContext boot（离线/401/demo 状态机）', () => {
  beforeEach(() => {
    localStorage.clear();
    handlers = [];
    getMeImpl = async () => { throw new Error('no impl'); };
  });

  it('无 token → 进登录门', async () => {
    render(<GameProvider><Probe /></GameProvider>);
    await waitFor(() => { expect(state().needsAuth).toBe(true); expect(state().loading).toBe(false); });
  });

  it('getMe 401 → 清 token + 进登录门（不静默降级 demo）', async () => {
    localStorage.setItem('dlg_token', 'stale');
    getMeImpl = async () => { const e = new Error('未登录或会话已过期'); e.status = 401; throw e; };
    render(<GameProvider><Probe /></GameProvider>);
    await waitFor(() => { expect(state().needsAuth).toBe(true); });
    expect(localStorage.getItem('dlg_token')).toBeNull();
  });

  it('网络错误 + 有缓存身份 → 恢复真实身份 + offline（X02）', async () => {
    localStorage.setItem('dlg_token', 'real');
    localStorage.setItem('dlg_cached_user', JSON.stringify({ id: 'u-123', username: '离线用户', avatar: '🐼', gameState: { hearts: 5 } }));
    getMeImpl = async () => { throw new TypeError('fetch failed'); };
    render(<GameProvider><Probe /></GameProvider>);
    await waitFor(() => {
      expect(state().user).toBe('u-123');
      expect(state().offline).toBe(true);
      expect(state().loading).toBe(false);
    });
  });

  it('网络错误 + 无缓存 → demo 降级 + offline（渲染不抛错 = Layout critical 不回归）', async () => {
    localStorage.setItem('dlg_token', 'real');
    getMeImpl = async () => { throw new TypeError('fetch failed'); };
    render(<GameProvider><Probe /></GameProvider>);
    await waitFor(() => {
      expect(state().user).toBe('demo');
      expect(state().offline).toBe(true);
    });
  });

  it('getMe 成功 → 真实身份 + 非 offline + 写身份缓存', async () => {
    localStorage.setItem('dlg_token', 'real');
    getMeImpl = async () => ({ id: 'u-9', username: '小明', avatar: '🦊', hearts: 4, coins: 200, xp: 10, last_streak_date: '2026-08-15' });
    render(<GameProvider><Probe /></GameProvider>);
    await waitFor(() => {
      expect(state().user).toBe('u-9');
      expect(state().offline).toBe(false);
    });
    expect(JSON.parse(localStorage.getItem('dlg_cached_user')).id).toBe('u-9');
  });
});
