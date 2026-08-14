const API_BASE = '/api';
const TOKEN_KEY = 'dlg_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Network error' }));
    const e = new Error(err.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// All user-scoped endpoints derive the user from the bearer token — never from
// a client-supplied userId (fixes the IDOR / 串号 P0).
export const api = {
  // Auth
  getMe: () => request('/auth/me'),
  register: (username, password) => request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  login: (username, password) => request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }),
  logout: () => request('/auth/logout', { method: 'POST', body: JSON.stringify({}) }),
  logoutAll: () => request('/auth/logout-all', { method: 'POST', body: JSON.stringify({}) }),
  changePassword: (oldPassword, newPassword) => request('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  }),

  // Courses
  getCourses: () => request('/courses'),
  getCourse: (courseId) => request(`/courses/${courseId}`),
  getUnit: (courseId, unitId) => request(`/courses/${courseId}/units/${unitId}`),
  getLesson: (courseId, unitId, lessonId) =>
    request(`/courses/${courseId}/units/${unitId}/lessons/${lessonId}`),
  completeLesson: (courseId, unitId, lessonId, data) =>
    request(`/courses/${courseId}/units/${unitId}/lessons/${lessonId}/complete`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getProgress: () => request('/courses/progress'),

  // Game
  getGameState: () => request('/game/state'),
  useHeart: () => request('/game/use-heart', { method: 'POST', body: JSON.stringify({}) }),
  restoreHeart: (amount) =>
    request('/game/restore-heart', { method: 'POST', body: JSON.stringify({ amount }) }),
  practiceHeal: (correctCount) =>
    request('/game/practice-heal', { method: 'POST', body: JSON.stringify({ correctCount }) }),
  getMistakes: () => request('/game/mistakes'),
  reviewMistake: (mistakeId, correct, userAnswer) =>
    request('/game/mistakes/review', { method: 'POST', body: JSON.stringify({ mistakeId, correct, userAnswer }) }),
  spendCoins: (amount, itemId) =>
    request('/game/spend-coins', { method: 'POST', body: JSON.stringify({ amount, itemId }) }),
  getLeaderboard: (league) => request(`/game/leaderboard/${league}`),
  getStreak: () => request('/game/streak'),
  checkin: () => request('/game/checkin', { method: 'POST', body: JSON.stringify({}) }),

  // Mock exam (P1)
  startExam: () => request('/exam/start', { method: 'POST', body: JSON.stringify({}) }),
  submitExam: (sessionId, answers) =>
    request('/exam/submit', { method: 'POST', body: JSON.stringify({ sessionId, answers }) }),
  examHistory: () => request('/exam/history'),
};
