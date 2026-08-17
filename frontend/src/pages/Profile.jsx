import { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';

export default function Profile() {
  const { user, gameState, logout, showToast } = useGame();
  const navigate = useNavigate();

  // 近 7 天复习活动（compare60 C07：review_log 画复习曲线）
  const [reviewActivity, setReviewActivity] = useState(null);
  useEffect(() => {
    if (user?.id && user.id !== 'demo') {
      api.reviewActivity().then(d => setReviewActivity(d.days || [])).catch(() => {});
    }
  }, [user]);

  // Settings (session management): change password / logout all devices.
  const [showSettings, setShowSettings] = useState(false);
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [logoutAllBusy, setLogoutAllBusy] = useState(false);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    if (pwNew.length < 6) { setPwError('新密码至少 6 位'); return; }
    if (pwNew !== pwConfirm) { setPwError('两次输入的新密码不一致'); return; }
    setPwBusy(true);
    try {
      await api.changePassword(pwOld, pwNew);
      // Server revoked EVERY session (including this one) — force re-login.
      showToast('密码已修改，请重新登录', 'success');
      logout();
    } catch (err) {
      setPwError(err.message || '修改失败，请重试');
    } finally {
      setPwBusy(false);
    }
  };

  const handleLogoutAll = async () => {
    if (!window.confirm('退出所有设备？当前设备也会被登出，需要重新登录。')) return;
    setLogoutAllBusy(true);
    try {
      await api.logoutAll();
      showToast('已在所有设备退出登录', 'success');
      logout();
    } catch (err) {
      showToast(err.message || '操作失败', 'error');
    } finally {
      setLogoutAllBusy(false);
    }
  };

  return (
    <div>
      {/* Profile header */}
      <div style={{
        textAlign: 'center',
        padding: '24px 0',
        marginBottom: 20,
      }}>
        <div style={{
          width: 80,
          height: 80,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #FF6B35, #FF8C42)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 40,
          margin: '0 auto 12px',
          color: 'white',
        }}>
          👤
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 800 }}>{user?.username || '小电工'}</h2>
        <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          {gameState?.league === 'gold' ? '🥇 黄金联赛' :
           gameState?.league === 'silver' ? '🥈 白银联赛' :
           '🥉 青铜联赛'}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
        marginBottom: 24,
      }}>
        {[
          { label: '连胜天数', value: `${gameState?.streak || 0} 天`, icon: '🔥', color: '#FF6B35' },
          { label: '总经验值', value: `${gameState?.xp || 0} XP`, icon: '⚡', color: '#1CB0F6' },
          { label: '金币', value: `${gameState?.coins || 0}`, icon: '🪙', color: '#FFD700' },
          { label: '红心', value: `${gameState?.hearts || 0}/${gameState?.max_hearts || 5}`, icon: '❤️', color: '#FF4B4B' },
        ].map(stat => (
          <div key={stat.label} style={{
            background: 'white',
            borderRadius: 'var(--radius-sm)',
            padding: '16px',
            boxShadow: 'var(--shadow)',
          }}>
            <div style={{ fontSize: 24, marginBottom: 4 }}>{stat.icon}</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: stat.color }}>{stat.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 近 7 天复习曲线（compare60 C07：review_log 每日复习次数 + 正确率） */}
      {reviewActivity && reviewActivity.length > 0 && (
        <div style={{
          background: 'white',
          borderRadius: 'var(--radius-sm)',
          padding: 16,
          boxShadow: 'var(--shadow)',
          marginBottom: 24,
        }}>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>📈 近 7 天复习</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            复习次数越多、正确率越高越好
          </div>
          <ReviewChart days={reviewActivity} />
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          className="btn btn-outline btn-block"
          onClick={() => navigate('/review')}
        >
          🏥 错题医疗包（复习错题，恢复红心）
        </button>
        <button
          className="btn btn-outline btn-block"
          onClick={async () => {
            if (user?.id === 'demo') { showToast('演示账号不支持导出', 'error'); return; }
            try {
              const blob = await api.exportMistakes();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `dlg_mistakes_${String(user?.id || 'me').slice(0, 8)}.tsv`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
              showToast('错题已导出为 TSV，可直接导入 Anki', 'success');
            } catch (err) {
              showToast(err.message || '导出失败，请稍后再试', 'error');
            }
          }}
        >
          📥 错题导出（Anki 兼容）
        </button>
        <button className="btn btn-outline btn-block">
          📊 学习统计
        </button>
        <button
          className="btn btn-outline btn-block"
          onClick={() => setShowSettings(s => !s)}
        >
          ⚙️ 设置 {showSettings ? '▲' : '▼'}
        </button>
        <button
          className="btn btn-outline btn-block"
          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
          onClick={() => {
            if (window.confirm('退出登录后，下次可通过账号密码重新登录找回进度。确定退出？')) {
              logout();
            }
          }}
        >
          🚪 退出登录
        </button>
      </div>

      {/* Settings: session management (修改密码 / 退出所有设备) */}
      {showSettings && (
        <div style={{
          marginTop: 20,
          background: 'white',
          borderRadius: 'var(--radius-sm)',
          padding: 16,
          boxShadow: 'var(--shadow)',
        }}>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>🔐 账号安全</div>

          {/* Change password */}
          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginTop: 4 }}>修改密码</div>
            <input
              type="password"
              placeholder="当前密码"
              value={pwOld}
              onChange={(e) => setPwOld(e.target.value)}
              style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border, #ddd)', fontSize: 14 }}
            />
            <input
              type="password"
              placeholder="新密码（至少 6 位）"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border, #ddd)', fontSize: 14 }}
            />
            <input
              type="password"
              placeholder="确认新密码"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border, #ddd)', fontSize: 14 }}
            />
            {pwError && (
              <div style={{ color: 'var(--danger)', fontSize: 13 }}>{pwError}</div>
            )}
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={pwBusy}
            >
              {pwBusy ? '提交中…' : '确认修改'}
            </button>
          </form>

          {/* Logout all devices */}
          <div style={{ borderTop: '1px solid var(--border, #eee)', marginTop: 16, paddingTop: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>退出所有设备</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              清除本账号在所有设备上的登录状态（包括当前设备）。
            </div>
            <button
              className="btn btn-outline btn-block"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              onClick={handleLogoutAll}
              disabled={logoutAllBusy}
            >
              {logoutAllBusy ? '处理中…' : '退出所有设备'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// 近 7 天复习曲线：服务端只返回有复习记录的日子，这里补全无记录日期让坐标轴完整；
// 柱 = 当日复习次数，柱顶标注 = 当日正确率。日期按上海时区生成，与服务端
// date(reviewed_at, '+8 hours') 分组口径一致（跨时区也不至于轴错位）。
function ReviewChart({ days }) {
  const byDay = {};
  for (const d of days) byDay[d.day] = d;

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date();
    t.setDate(t.getDate() - i);
    labels.push(fmt.format(t));
  }

  const rows = labels.map(key => byDay[key] || { day: key, reviews: 0, pct_correct: null });
  const max = Math.max(1, ...rows.map(r => r.reviews));
  const isToday = day => day === labels[6];

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 108 }}>
      {rows.map(r => (
        <div key={r.day} style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-end',
          height: '100%',
        }}>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            marginBottom: 2,
            color: r.pct_correct == null ? 'var(--text-secondary)' :
              r.pct_correct >= 80 ? '#16a34a' : r.pct_correct >= 50 ? '#d97706' : '#dc2626',
          }}>
            {r.pct_correct == null ? '' : `${r.pct_correct}%`}
          </div>
          <div style={{
            width: '100%',
            maxWidth: 22,
            borderRadius: 4,
            height: `${Math.max(3, (r.reviews / max) * 56)}px`,
            background: r.reviews > 0
              ? 'linear-gradient(180deg, #FF8C42, #FF6B35)'
              : 'var(--border, #eee)',
          }} />
          <div style={{
            fontSize: 10,
            marginTop: 4,
            color: isToday(r.day) ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: isToday(r.day) ? 700 : 400,
          }}>
            {isToday(r.day) ? '今天' : r.day.slice(5).replace('-', '/')}
          </div>
        </div>
      ))}
    </div>
  );
}
