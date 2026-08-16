import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import { useGame } from '../context/GameContext';

const LEAGUES = [
  { id: 'bronze',  name: '青铜', emoji: '🥉', color: '#CD7F32', next: 'silver' },
  { id: 'silver',  name: '白银', emoji: '🥈', color: '#C0C0C0', next: 'gold' },
  { id: 'gold',    name: '黄金', emoji: '🥇', color: '#FFD700', next: 'emerald' },
  { id: 'emerald', name: '翡翠', emoji: '💎', color: '#50C878', next: 'diamond' },
  { id: 'diamond', name: '钻石', emoji: '👑', color: '#B9F2FF', next: null },
];

function formatCountdown(ms) {
  if (ms <= 0) return '结算中…';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}天 ${h}小时 ${m}分`;
  if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
  return `${m}分 ${s}秒`;
}

export default function Leaderboard() {
  const { user, gameState } = useGame();
  const [viewLeague, setViewLeague] = useState(null);  // null means "my league"
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const myLeague = gameState?.league || 'bronze';
  const currentView = viewLeague || myLeague;
  const isViewingOwnLeague = currentView === myLeague;

  // Real-time countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load leaderboard data
  useEffect(() => {
    setLoading(true);
    api.getLeaderboard(currentView)
      .then(d => setData(d || {}))
      .catch(() => setData({}))
      .finally(() => setLoading(false));
  }, [currentView, user, gameState?.xp]);

  const weekEndsMs = data?.week_ends_at ? Date.parse(data.week_ends_at) : null;
  const timeLeft = weekEndsMs ? weekEndsMs - now : null;
  const isUrgent = timeLeft !== null && timeLeft > 0 && timeLeft < 24 * 3600 * 1000;

  const entries = data?.entries || [];
  const myRank = data?.my_rank;
  const myXP = data?.my_xp ?? gameState?.xp ?? 0;
  const promoZoneEnd = data?.promotion_zone_end || 0;
  const demoZoneStart = data?.demotion_zone_start || Infinity;
  const xpToPromotion = data?.xp_to_promotion ?? 0;
  const inPromoZone = data?.in_promotion_zone;
  const inDemoZone = data?.in_demotion_zone;

  const viewLeagueMeta = LEAGUES.find(l => l.id === currentView) || LEAGUES[0];
  const myLeagueMeta = LEAGUES.find(l => l.id === myLeague) || LEAGUES[0];
  const nextLeagueMeta = LEAGUES.find(l => l.id === myLeagueMeta.next);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>🏆 排行榜</h1>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          每周结算 · 前 {promoZoneEnd || 5} 名晋升 · 后 {demoZoneStart && entries.length ? Math.max(0, entries.length - demoZoneStart + 1) : 5} 名降级
        </div>
      </div>

      {/* League Tabs - all 5 leagues; spectator mode for non-own */}
      <div className="lb-league-tabs" style={{ flexWrap: 'wrap' }}>
        {LEAGUES.map(l => {
          const isMine = l.id === myLeague;
          const isActive = currentView === l.id;
          return (
            <button
              key={l.id}
              className={`lb-league-tab ${isActive ? 'active' : ''}`}
              onClick={() => setViewLeague(l.id)}
              style={{
                borderColor: isActive ? l.color : 'var(--border)',
                background: isActive ? `${l.color}22` : 'white',
                position: 'relative',
              }}
              title={isMine ? '你所在的联赛' : `查看 ${l.name} 联赛`}
            >
              {l.emoji} {l.name}
              {isMine && (
                <span style={{
                  position: 'absolute', top: -6, right: -6,
                  background: 'var(--primary)', color: 'white',
                  borderRadius: '50%', width: 16, height: 16,
                  fontSize: 10, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>✓</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Spectator banner */}
      {!isViewingOwnLeague && (
        <div style={{
          background: 'var(--tint-orange)', color: '#8B5A00',
          padding: '10px 14px', borderRadius: 'var(--radius-xs)',
          marginBottom: 12, fontSize: 13, fontWeight: 600,
        }}>
          👀 你正在围观 {viewLeagueMeta.name} 联赛 — 你目前在 <strong>{myLeagueMeta.emoji} {myLeagueMeta.name}</strong>
        </div>
      )}

      {/* My status card (only for own league) */}
      {isViewingOwnLeague && (
        <div style={{
          background: `linear-gradient(135deg, ${viewLeagueMeta.color}, #333)`,
          borderRadius: 'var(--radius)',
          padding: '16px 18px',
          color: 'white',
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <span style={{ fontSize: 36 }}>{viewLeagueMeta.emoji}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{user?.username || '小电工'}</div>
              <div style={{ fontSize: 13, opacity: 0.95 }}>
                {viewLeagueMeta.name} 联赛 · 第 {myRank || '?'} 名 · 本周 {myXP} XP
              </div>
            </div>
            <div style={{
              textAlign: 'right', fontSize: 12,
              padding: '6px 10px', borderRadius: 8,
              background: isUrgent ? 'rgba(255,75,75,0.85)' : 'rgba(0,0,0,0.25)',
              fontWeight: 700,
              animation: isUrgent ? 'pulse 1.5s ease-in-out infinite' : 'none',
            }}>
              ⏱️ {timeLeft !== null ? formatCountdown(timeLeft) : '加载中'}<br/>
              <span style={{ fontWeight: 400, fontSize: 11, opacity: 0.85 }}>本周结算倒计时</span>
            </div>
          </div>

          {/* Promotion progress bar */}
          {nextLeagueMeta && xpToPromotion > 0 && !inPromoZone && (
            <div>
              <div style={{ fontSize: 12, opacity: 0.95, marginBottom: 4 }}>
                再获得 <strong style={{ fontSize: 14 }}>{xpToPromotion} XP</strong> 即可晋升 {nextLeagueMeta.emoji} {nextLeagueMeta.name}
              </div>
              <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                <div style={{
                  background: '#7ED321',
                  height: '100%',
                  width: `${Math.min(100, (myXP / Math.max(1, myXP + xpToPromotion)) * 100)}%`,
                  borderRadius: 4,
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          )}
          {inPromoZone && (
            <div style={{
              background: 'rgba(126,211,33,0.25)',
              padding: '8px 12px', borderRadius: 8,
              fontWeight: 700, fontSize: 13,
            }}>
              🎉 你在晋升区！本周结束时升入 {nextLeagueMeta?.emoji} {nextLeagueMeta?.name}
            </div>
          )}
          {inDemoZone && (
            <div style={{
              background: 'rgba(255,75,75,0.35)',
              padding: '8px 12px', borderRadius: 8,
              fontWeight: 700, fontSize: 13,
            }}>
              ⚠️ 你在降级区！再不努力会掉到下一档
            </div>
          )}
        </div>
      )}

      {/* Leaderboard list with promotion/demotion zone colors */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20 }}>加载中...</div>
      ) : entries.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-secondary)' }}>
          本联赛暂无玩家
        </div>
      ) : (
        <div style={{ background: 'white', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {entries.map((entry, idx) => {
            const rank = entry.rank || (idx + 1);
            const isMe = entry.user_id === user?.id;
            const inPromo = rank <= promoZoneEnd && promoZoneEnd > 0;
            const inDemo = rank >= demoZoneStart && demoZoneStart !== Infinity;
            const isBelowFold = entry.is_below_fold;

            // Pick row background
            let rowBg = 'transparent';
            let rowBorder = '1px solid var(--border)';
            if (isMe) {
              rowBg = inPromo ? 'var(--tint-success-2)' : inDemo ? 'var(--tint-danger-2)' : 'var(--tint-warning)';
              rowBorder = `2px solid ${inPromo ? 'var(--primary)' : inDemo ? 'var(--danger)' : 'var(--gold)'}`;
            } else if (inPromo) {
              rowBg = 'var(--tint-success-3)';
            } else if (inDemo) {
              rowBg = 'var(--tint-danger)';
            }

            return (
              <div key={entry.user_id || idx}>
                {isBelowFold && (
                  <div style={{
                    textAlign: 'center', padding: '8px 0', fontSize: 12,
                    color: 'var(--text-secondary)', borderTop: '1px dashed var(--border)',
                  }}>... 中间还有 {Math.max(0, rank - entries.length) + 0} 位 ...</div>
                )}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px', background: rowBg,
                  borderBottom: rowBorder, position: 'relative',
                }}>
                  {/* Rank */}
                  <div style={{
                    width: 32, textAlign: 'center', fontWeight: 800,
                    fontSize: rank <= 3 ? 18 : 15,
                    color: rank === 1 ? '#FFD700' : rank === 2 ? '#C0C0C0' : rank === 3 ? '#CD7F32' : 'var(--text)',
                  }}>
                    {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank}
                  </div>
                  {/* Avatar */}
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: '#F0F0F0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 20,
                  }}>
                    {entry.avatar && entry.avatar !== 'default' && entry.avatar !== 'ghost'
                      ? entry.avatar : '👤'}
                  </div>
                  {/* Name */}
                  <div style={{ flex: 1, fontWeight: isMe ? 700 : 500, fontSize: 14 }}>
                    {entry.username}
                    {isMe && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--primary)' }}>(你)</span>}
                    {inPromo && !isMe && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--primary)' }}>↑</span>}
                    {inDemo && !isMe && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--danger)' }}>↓</span>}
                  </div>
                  {/* XP */}
                  <div style={{
                    fontWeight: 700,
                    fontSize: 14,
                    color: inPromo ? 'var(--primary)' : inDemo ? 'var(--danger)' : 'var(--blue)',
                  }}>
                    {entry.xp_earned} XP
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* League progression hint */}
      <div style={{
        marginTop: 20,
        padding: 14,
        background: '#F8F8F8',
        borderRadius: 'var(--radius-xs)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        lineHeight: 1.7,
      }}>
        <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 6, fontSize: 13 }}>
          🪜 联赛阶梯
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {LEAGUES.map((l, i) => (
            <span key={l.id} style={{
              padding: '4px 8px', borderRadius: 12,
              background: l.id === myLeague ? `${l.color}33` : '#EEE',
              border: l.id === myLeague ? `2px solid ${l.color}` : '1px solid #CCC',
              fontWeight: l.id === myLeague ? 700 : 400,
              fontSize: 11,
              color: l.id === myLeague ? '#222' : '#888',
            }}>
              {l.emoji}{l.name}
            </span>
          )).flatMap((el, i, arr) => i < arr.length - 1 ? [el, <span key={`s${i}`} style={{ color: '#BBB' }}>→</span>] : [el])}
        </div>
        <div style={{ marginTop: 8 }}>
          • 前 7 名（青铜）/ 前 5 名（其他）晋升 · 后 5 名降级 · 周 XP {'<'} 50 免降<br/>
          • 经验值通过完成课程、签到、连胜奖励获得
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.85; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}
