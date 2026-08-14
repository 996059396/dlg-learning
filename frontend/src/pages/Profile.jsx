import { useGame } from '../context/GameContext';
import { useNavigate } from 'react-router-dom';

export default function Profile() {
  const { user, gameState, logout } = useGame();
  const navigate = useNavigate();

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

      {/* Quick actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          className="btn btn-outline btn-block"
          onClick={() => navigate('/review')}
        >
          🏥 错题医疗包（复习错题，恢复红心）
        </button>
        <button className="btn btn-outline btn-block">
          📊 学习统计
        </button>
        <button className="btn btn-outline btn-block">
          ⚙️ 设置
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
    </div>
  );
}
