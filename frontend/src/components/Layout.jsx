import { useRef, useLayoutEffect } from 'react';
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
  const { toast, gameState, offline, user } = useGame();
  const headerRef = useRef(null);

  const isLessonPage = location.pathname.includes('/lesson/');

  // Publish the real app-header height so in-page sticky bars (MockExam HUD)
  // can park below it instead of being covered (header z-index:100). Measures
  // before paint so the variable is correct on first render, and again on
  // resize/zoom for font-scale changes.
  useLayoutEffect(() => {
    const publish = () => {
      const el = headerRef.current;
      if (el) {
        document.documentElement.style.setProperty('--app-header-h', `${el.offsetHeight}px`);
      }
    };
    publish();
    window.addEventListener('resize', publish);
    return () => window.removeEventListener('resize', publish);
  }, [isLessonPage]);

  return (
    <div className="app-container">
      {offline && (
        <div className="offline-banner" role="status">
          {user?.id === 'demo'
            ? '📡 演示模式：未登录，离线可试学，成绩不会保存'
            : '📡 离线模式：课程可继续学习，成绩将在联网后自动同步'}
        </div>
      )}
      {!isLessonPage && (
        <header ref={headerRef} className="app-header">
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
