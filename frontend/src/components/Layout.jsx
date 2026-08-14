import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useGame } from '../context/GameContext';

const NAV_ITEMS = [
  { path: '/', icon: '🏠', label: '学习' },
  { path: '/shop', icon: '🛒', label: '商店' },
  { path: '/leaderboard', icon: '🏆', label: '排行' },
  { path: '/profile', icon: '👤', label: '个人' },
];

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { toast, gameState } = useGame();

  const isLessonPage = location.pathname.includes('/lesson/');

  return (
    <div className="app-container">
      {!isLessonPage && (
        <header className="app-header">
          <div className="logo">⚡ DLG电工</div>
          <div className="hud-bar">
            <div className="hud-item hud-hearts">
              ❤️ {gameState?.hearts ?? 5}
            </div>
            <div className="hud-item hud-coins">
              🪙 {gameState?.coins ?? 0}
            </div>
            <div className="hud-item hud-xp">
              ⚡ {gameState?.xp ?? 0}
            </div>
          </div>
        </header>
      )}

      <div className="app-content" style={isLessonPage ? { padding: 0, paddingBottom: 0 } : {}}>
        <Outlet />
      </div>

      {!isLessonPage && (
        <nav className="bottom-nav">
          {NAV_ITEMS.map(item => (
            <button
              key={item.path}
              className={`nav-item ${location.pathname === item.path ? 'active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
