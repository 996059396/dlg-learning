import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getToken, setToken, onUnauthorized } from '../utils/api';
import { flushOfflineQueue } from '../utils/offlineQueue';
import { readCachedUser, writeCachedUser, clearCachedUser } from '../utils/sessionCache';

const GameContext = createContext(null);

const DEMO_USER = { id: 'demo', username: '小电工', avatar: 'default' };
const DEMO_STATE = {
  hearts: 5, max_hearts: 5, coins: 500, xp: 0, streak: 0,
  league: 'bronze', xp_boost_multiplier: 1.0, xp_boost_until: null,
  freeze_item_count: 0, streak_shield_count: 0, last_streak_date: null,
};

function gsFrom(data) {
  return {
    hearts: data.hearts ?? 5,
    max_hearts: data.max_hearts ?? 5,
    coins: data.coins ?? 500,
    xp: data.xp ?? 0,
    streak: data.streak ?? 0,
    league: data.league ?? 'bronze',
    xp_boost_multiplier: data.xp_boost_multiplier ?? 1.0,
    xp_boost_until: data.xp_boost_until,
    freeze_item_count: data.freeze_item_count ?? 0,
    streak_shield_count: data.streak_shield_count ?? 0,
    last_streak_date: data.last_streak_date,
  };
}

// Asia/Shanghai date string (UTC+8). The backend stores streaks in Shanghai
// time; comparing against the UTC date here would mis-flag "already checked in"
// between local midnight and 08:00.
function shanghaiToday() {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return shifted.toISOString().split('T')[0];
}

export function GameProvider({ children }) {
  const [user, setUser] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checkedInToday, setCheckedInToday] = useState(false);
  const [toast, setToast] = useState(null);
  // Identity gate: when there is no valid session we require explicit
  // login/register instead of silently minting a throwaway account.
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  // X02 offline mode: true when the identity was restored from the session cache
  // because the network is down — the UI shows a banner and queued completions
  // are flushed on reconnect.
  const [offline, setOffline] = useState(false);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Boot: load the session if a token exists. No auto-register, and a stale
  // token (401) NEVER re-registers — that used to abandon the account and all
  // its progress/coins/streak. Instead we clear the token and require login.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!getToken()) {
          if (!cancelled) setNeedsAuth(true);
          return;
        }
        let data;
        try {
          data = await api.getMe();
        } catch (err) {
          if (err.status === 401) {
            setToken(null);
            clearCachedUser();
            if (!cancelled) setNeedsAuth(true);
            return;
          }
          // Network failure (X02): restore the last-known identity so offline
          // lesson completions queue under the real account instead of dropping
          // to demo. The token is still present; it's simply unverifiable now.
          const cached = readCachedUser();
          if (cached) {
            if (!cancelled) {
              setUser({ id: cached.id, username: cached.username, avatar: cached.avatar });
              setGameState(cached.gameState || DEMO_STATE);
              if (cached.checkedInToday) setCheckedInToday(true);
              setOffline(true);
            }
            console.warn('[boot] 网络不可用，使用缓存身份（离线模式）:', cached.username);
            return;
          }
          throw err;
        }
        if (cancelled) return;
        setUser(data);
        setGameState(gsFrom(data));
        if (data.last_streak_date === shanghaiToday()) setCheckedInToday(true);
        writeCachedUser({
          id: data.id,
          username: data.username,
          avatar: data.avatar,
          gameState: gsFrom(data),
          checkedInToday: data.last_streak_date === shanghaiToday(),
        });
      } catch (err) {
        console.error('Failed to load user:', err);
        if (!cancelled) {
          // 静默降级 demo（crosscheck4 Phase4）：网络失败且无缓存身份时，降级要
          // 显式可见——banner 提示演示模式、成绩不会保存，而不是让用户误以为在
          // 真账号里学习（真离线由 X02 缓存身份路径处理并自动同步）。
          setUser(DEMO_USER);
          setGameState(DEMO_STATE);
          setOffline(true);
          showToast('暂时无法连接，已进入演示模式（未登录，成绩不会保存）', 'warn');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Session-died global fallback (P32 P2-3): any 401 from a user-scoped endpoint
  // mid-use (token revoked via logout-all / change-password on another device, DB
  // reset) must drop the stale session and return to the auth gate — not strand
  // the UI on a dead token. Boot-time getMe 401 and the gate's own login 401s are
  // handled separately, so this only fires for mid-session expiry.
  useEffect(() => {
    const unsub = onUnauthorized(() => {
      setToken(null);
      clearCachedUser();
      setUser(null);
      setGameState(null);
      setCheckedInToday(false);
      setOffline(false);
      setNeedsAuth(true);
    });
    return unsub;
  }, []);

  // Explicit login/register — the ONLY ways to obtain a session now.
  const submitAuth = useCallback(async ({ mode, username, password }) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { token } = mode === 'register'
        ? await api.register(username, password)
        : await api.login(username, password);
      setToken(token);
      const data = await api.getMe();
      setUser(data);
      setGameState(gsFrom(data));
      setOffline(false);
      if (data.last_streak_date === shanghaiToday()) setCheckedInToday(true);
      setNeedsAuth(false);
      writeCachedUser({
        id: data.id,
        username: data.username,
        avatar: data.avatar,
        gameState: gsFrom(data),
        checkedInToday: data.last_streak_date === shanghaiToday(),
      });
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  // Logout: revoke the session server-side, then return to the auth gate.
  const logout = useCallback(async () => {
    try { await api.logout(); } catch (e) { /* best-effort revoke */ }
    setToken(null);
    clearCachedUser();
    setUser(null);
    setGameState(null);
    setCheckedInToday(false);
    setOffline(false);
    setNeedsAuth(true);
  }, []);

  const refreshGameState = useCallback(async () => {
    if (!user?.id || user.id === 'demo') return;
    try {
      setGameState(gsFrom(await api.getGameState()));
    } catch (e) {
      console.error('Failed to refresh game state:', e);
    }
  }, [user]);

  // X02 offline sync: on boot and whenever the connection returns, replay the
  // current user's queued offline lesson completions. The server re-grades them
  // and dedupes by client_request_id, so a reconnect never double-mints.
  const flushPending = useCallback(async () => {
    if (!user?.id || user.id === 'demo') return;
    try {
      const summary = await flushOfflineQueue(user.id);
      if (summary.total > 0) {
        const parts = [];
        if (summary.synced > 0) parts.push(`已同步 ${summary.synced} 条`);
        if (summary.blocked > 0) parts.push(`${summary.blocked} 条需处理（红心不足）`);
        if (summary.failed > 0) parts.push(`${summary.failed} 条稍后自动重试`);
        showToast(`离线成绩${parts.length ? parts.join('，') : '已处理'}`, summary.synced > 0 ? 'success' : 'info');
        if (summary.synced > 0) refreshGameState();
      }
    } catch (e) {
      console.error('[offlineQueue] flush failed:', e);
    }
  }, [user, showToast, refreshGameState]);

  useEffect(() => {
    flushPending();
    const onOnline = () => {
      // crosscheck5 X M3：重连后必须解除离线横幅 + 刷新真实账号状态，否则 UI
      // 一直显示「离线模式」与陈旧 gameState，直到手动刷新/重登。
      setOffline(false);
      refreshGameState();
      flushPending();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flushPending, refreshGameState]);

  const useHeart = useCallback(async () => {
    if (user?.id === 'demo') {
      if (gameState.hearts <= 0) return { success: false, canPractice: true };
      setGameState(s => ({ ...s, hearts: s.hearts - 1 }));
      return { success: true };
    }
    try {
      const result = await api.useHeart();
      setGameState(gsFrom(result));
      return { success: true };
    } catch (e) {
      // crosscheck5 X H4：网络错误（无 status，非「红心不足」400）时离线学习不能
      // 被当成红心不足堵死入口——本地扣减放行进课（离线扣心不持久，联网重放时
      // 服务端按 /complete 红心门禁重新结算）。
      if (!e.status && gameState.hearts > 0) {
        setGameState(s => ({ ...s, hearts: s.hearts - 1 }));
        return { success: true, offline: true };
      }
      return { success: false, error: e.message };
    }
  }, [user, gameState]);

  const spendCoins = useCallback(async (amount, itemId) => {
    if (user?.id === 'demo') {
      if (gameState.coins < amount) return { error: '金币不足' };
      setGameState(s => ({ ...s, coins: s.coins - amount }));
      return { success: true };
    }
    try {
      const state = await api.spendCoins(amount, itemId);
      setGameState(gsFrom(state));
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }, [user, gameState]);

  const checkIn = useCallback(async () => {
    if (checkedInToday) {
      showToast('今日已签到 ✅', 'info');
      return { alreadyCheckedIn: true };
    }
    if (user?.id === 'demo') {
      const newStreak = (gameState.streak || 0) + 1;
      const coinBonus = Math.min(newStreak * 10, 100);
      setGameState(s => ({ ...s, streak: newStreak, coins: (s.coins || 0) + coinBonus }));
      setCheckedInToday(true);
      showToast(`签到成功！连胜 ${newStreak} 天 🔥 +${coinBonus} 金币`, 'success');
      return { streak: newStreak, coinBonus };
    }
    try {
      const result = await api.checkin();
      if (result.alreadyCheckedIn) {
        setCheckedInToday(true);
        showToast('今日已签到 ✅', 'info');
        return result;
      }
      setGameState(gsFrom(result));
      setCheckedInToday(true);
      showToast(`签到成功！连胜 ${result.streak} 天 🔥 +${result.coinBonus || 0} 金币`, 'success');
      return result;
    } catch (e) {
      showToast('签到失败，请重试', 'error');
      return { error: e.message };
    }
  }, [user, gameState, checkedInToday, showToast]);

  // Server is now the source of truth for coins/XP — this only surfaces toasts
  // for cosmetic reward events; the authoritative state comes from the server response.
  const applyRewards = useCallback(async (rewards) => {
    if (!rewards) return;
    if (rewards.xpBoostTriggered) {
      showToast('⚡ 触发15分钟双倍经验加成！', 'success');
    }
  }, [showToast]);

  const value = {
    user, gameState, loading, toast, checkedInToday, offline,
    showToast, refreshGameState, useHeart, spendCoins,
    checkIn, applyRewards, setGameState,
    needsAuth, authMode, setAuthMode, authError, authBusy,
    submitAuth, logout,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be inside GameProvider');
  return ctx;
}
