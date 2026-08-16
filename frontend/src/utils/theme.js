// 主题（浅色/深色/跟随系统）——用户决策「加深色模式」。
// 状态存 localStorage('dlg_theme')，显式 'light'/'dark' 打在 <html data-theme>，
// 'system'（或未设）则移除 data-theme，交给 CSS 的 prefers-color-scheme。
const THEME_KEY = 'dlg_theme';

export function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const el = document.documentElement;
  if (saved === 'light' || saved === 'dark') el.dataset.theme = saved;
  else delete el.dataset.theme; // 跟随系统
}

// 循环：浅色 → 深色 → 跟随系统 → 浅色…
export function cycleTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const next = saved === 'dark' ? 'light' : saved === 'light' ? 'system' : 'dark';
  const el = document.documentElement;
  if (next === 'system') { localStorage.removeItem(THEME_KEY); delete el.dataset.theme; }
  else { localStorage.setItem(THEME_KEY, next); el.dataset.theme = next; }
  return next;
}

export function currentTheme() {
  const s = localStorage.getItem(THEME_KEY);
  if (s === 'light' || s === 'dark') return s;
  return (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
