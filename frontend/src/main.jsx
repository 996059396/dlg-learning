import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Top-level error boundary: a render exception anywhere used to unmount #root
// and white-screen the whole SPA (e.g. the MockExam multi-select crash). Catch
// it here, show a recoverable message instead, and offer a reload.
class RootBoundary extends React.Component {
  state = { hasError: false, msg: '' };
  static getDerivedStateFromError(err) {
    return { hasError: true, msg: err?.message || String(err) };
  }
  componentDidCatch(err, info) {
    console.error('[RootBoundary]', err, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ maxWidth: 480, margin: '80px auto', padding: '0 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>💥</div>
          <h2 style={{ marginBottom: 8 }}>页面出了点问题</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
            {this.state.msg || '未知渲染错误'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '10px 22px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>
);

// PWA shell (X02): register the service worker for offline lesson support.
// Registration lives in the bundled module rather than an inline <script> —
// the production CSP is script-src 'self', which blocks inline scripts.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('[SW] registration failed:', err);
    });
  });
}
