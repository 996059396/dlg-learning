import { useState } from 'react';
import { useGame } from '../context/GameContext';

// Identity gate shown when there is no valid session. The app no longer
// auto-creates throwaway accounts (that silently abandoned a user's progress on
// token expiry) — a returning learner logs in, a new one registers, both with a
// recoverable username + password.
export default function AuthScreen() {
  const { authMode, setAuthMode, submitAuth, authError, authBusy } = useGame();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const isRegister = authMode === 'register';

  const onSubmit = (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    submitAuth({ mode: authMode, username: username.trim(), password });
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">⚡</div>
        <h1 className="auth-title">DLG 电工</h1>
        <p className="auth-sub">
          {isRegister ? '创建账号，保存你的学习进度' : '登录后继续你的电工考证之路'}
        </p>

        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${!isRegister ? 'auth-tab-active' : ''}`}
            onClick={() => { setAuthMode('login'); setUsername(''); setPassword(''); }}
          >
            登录
          </button>
          <button
            type="button"
            className={`auth-tab ${isRegister ? 'auth-tab-active' : ''}`}
            onClick={() => { setAuthMode('register'); setUsername(''); setPassword(''); }}
          >
            注册
          </button>
        </div>

        <form onSubmit={onSubmit} className="auth-form">
          <input
            className="auth-input"
            type="text"
            placeholder="用户名"
            value={username}
            maxLength={24}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            className="auth-input"
            type="password"
            placeholder={isRegister ? '设置密码（至少 6 位）' : '密码'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />

          {authError && <div className="auth-error">{authError}</div>}

          <button
            type="submit"
            className="auth-submit"
            disabled={authBusy || !username.trim() || !password}
          >
            {authBusy ? '请稍候…' : isRegister ? '注册并开始' : '登录'}
          </button>
        </form>

        <p className="auth-note">
          🔒 账号和进度保存在本地服务器，支持随时登录找回。
        </p>
      </div>
    </div>
  );
}
