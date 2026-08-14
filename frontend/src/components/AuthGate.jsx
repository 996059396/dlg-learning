import { useGame } from '../context/GameContext';
import AuthScreen from './AuthScreen';

// Renders the auth gate until a valid session is present, then the app.
export default function AuthGate({ children }) {
  const { loading, needsAuth } = useGame();
  if (loading) {
    return (
      <div className="auth-loading">
        <div className="auth-loading-spinner" />
        <div>加载中…</div>
      </div>
    );
  }
  if (needsAuth) return <AuthScreen />;
  return children;
}
