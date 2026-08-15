import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getToken, setToken, onUnauthorized } from '../utils/api';

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
            if (!cancelled) setNeedsAuth(true);
            return;
          }
          throw err;
        }
        if (cancelled) return;
        setUser(data);
        setGameState(gsFrom(data));
        if (data.last_streak_date === shanghaiToday()) setCheckedInToday(true);
      } catch (err) {
        console.error('Failed to load user:', err);
        if (!cancelled) {
          setUser(DEMO_USER);
          setGameState(DEMO_STATE);
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
      setUser(null);
      setGameState(null);
      setCheckedInToday(false);
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
      if (data.last_streak_date === shanghaiToday()) setCheckedInToday(true);
      setNeedsAuth(false);
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
    setUser(null);
    setGameState(null);
    setCheckedInToday(false);
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
    user, gameState, loading, toast, checkedInToday,
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
