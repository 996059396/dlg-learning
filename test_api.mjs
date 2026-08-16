#!/usr/bin/env node
// API contract test suite — self-contained.
// Boots its own server on an isolated DB (DLG_DB_PATH) and verifies the CURRENT
// contract: DB-opaque token session auth (not JWT — SHA-256 hashed in sessions),
// public course catalog, server-side grading, economy (server-priced spend,
// idempotent rewards), leaderboard, mistakes.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// Fail fast with a clear message if the running Node is too old for
// better-sqlite3@13 (Node>=22 ABI). Under Node 20 the module load below crashes
// with a segfault / NODE_MODULE_VERSION error; this guard replaces that with a
// readable hint. Run with Node 24 (better-sqlite3 v13 ABI 137), e.g. via nvm or a node24 binary.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`[fatal] DLG tests require Node >= 22 (better-sqlite3 v13 ABI 137); got Node ${process.version}. Use a Node 24 binary.`);
  process.exit(1);
}

const req = createRequire(import.meta.url);
const Database = req(path.join(import.meta.dirname, 'backend', 'node_modules', 'better-sqlite3'));

const PORT = 3998;
const BASE = `http://localhost:${PORT}/api`;
const DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dlg-api-')), 'test.db');

let passed = 0;
let failed = 0;
let token = null;
let userId = null;
const errors = [];

const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

async function jreq(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    const msg = `  ❌ ${name}: ${e.message}`;
    console.log(msg);
    errors.push(msg);
  }
}

// Build an answer entry for every gradeable node — SIMULATING THE REAL FRONTEND:
// answers are keyed by the stable node.id (primary) plus the ABSOLUTE node
// position in lesson.nodes (what LessonPlayer actually sends). wrongQ is the
// 0-based index within the questionNodes sequence (-1 = all right).
function buildAnswers(lesson, wrongQ = -1) {
  const answers = [];
  const questionNodes = lesson.nodes.filter(n => n.type !== 'info');
  questionNodes.forEach((node, q) => {
    const nodeIndex = lesson.nodes.indexOf(node); // absolute index, as the client sends
    // Interactive sims are serialized exactly as the real frontend does; the
    // server re-grades them structurally (no client claim to trust).
    if (node.type === 'simulation_probe') {
      const cp = node.correct_probes || {};
      answers.push({ nodeId: node.id, nodeIndex, userAnswer: `红:${cp.red},黑:${cp.black}`, correct: true });
      return;
    }
    if (node.type === 'multimeter_challenge') {
      const cs = node.correct_setup || {};
      const hs = node.target?.hotspots || {};
      const label = (k) => (Array.isArray(hs) ? hs.find(h => h?.id === k)?.label : hs[k]?.label) || k;
      answers.push({
        nodeId: node.id, nodeIndex,
        userAnswer: `档位:${cs.dial}, 红:${cs.red_port}→${label(cs.red_touch)}, 黑:${cs.black_port}→${label(cs.black_touch)}`,
        correct: true,
      });
      return;
    }
    if (node.type === 'simulation_danger') {
      answers.push({ nodeId: node.id, nodeIndex, userAnswer: '安全操作', correct: true });
      return;
    }
    let userAnswer;
    const wrong = q === wrongQ;
    switch (node.type) {
      case 'multiple_choice': {
        const correct = node.options.find(o => o.is_correct);
        const other = node.options.find(o => !o.is_correct);
        userAnswer = wrong && other ? other.text : correct.text;
        break;
      }
      case 'true_false':
        userAnswer = wrong ? (node.correct_answer ? '错误' : '正确') : (node.correct_answer ? '正确' : '错误');
        break;
      case 'fill_blank':
        userAnswer = wrong ? '__错误答案__' : (node.answer || node.acceptable_answers?.[0] || '');
        break;
      case 'simulation_dial': {
        const correct = node.dial_options.find(o => o.is_correct);
        const other = node.dial_options.find(o => !o.is_correct);
        userAnswer = wrong && other ? other.label : correct.label;
        break;
      }
      case 'simulation_danger':
        userAnswer = '安全操作（先换表笔再测量）';
        break;
      case 'sort':
        // Real frontend serialization (LessonPlayer SortQuestion): items joined by ','.
        userAnswer = node.correct_order.map(id => node.items.find(x => x.id === id)?.text).filter(Boolean).join(',');
        break;
      case 'match':
        // Real frontend serialization (LessonPlayer MatchQuestion): "left=right" pairs.
        userAnswer = node.pairs.map(p => `${p.left}=${p.right}`).join(', ');
        break;
      case 'drag_drop':
        userAnswer = node.target_zone?.label || '';
        break;
      default:
        userAnswer = '';
    }
    answers.push({ nodeId: node.id, nodeIndex, userAnswer });
  });
  return answers;
}

// Spawn with the SAME runtime that runs this test (process.execPath), never
// 'node' from PATH: better-sqlite3@13 is Node>=22 ABI, and the default PATH
// node20 crashes on load with a cryptic "server did not start" (V02/P38 P0).
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(import.meta.dirname, 'backend'),
  env: {
    ...process.env,
    PORT: String(PORT),
    DLG_DB_PATH: DB_PATH,
    // Test-suite runs register/login dozens of throwaway accounts in one run;
    // scale up the shared per-IP auth bucket AND the independent register bucket
    // (prod never sets these → unchanged behavior).
    'DLG_RATE_MAX_auth-ip': '1000',
    'DLG_RATE_MAX_register': '1000',
  },
  stdio: 'pipe',
});
server.stderr.on('data', d => { if (String(d).includes('Error')) console.error('[server]', String(d)); });

function waitForServer(attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryOnce = async (n) => {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) return resolve();
      } catch {}
      if (n <= 0) return reject(new Error('server did not start'));
      setTimeout(() => tryOnce(n - 1), 250);
    };
    tryOnce(attempts);
  });
}

async function run() {
  await waitForServer();
  console.log('\n🧪 DLG Learning System - API Contract Test Suite\n');
  console.log('═'.repeat(50));

  // ─── Auth & User ───
  console.log('\n📋 Auth & User');
  await test('401 without token on /auth/me', async () => {
    const { status } = await jreq('GET', '/auth/me');
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });

  await test('POST /auth/register requires password (400 without / short)', async () => {
    const noPw = await jreq('POST', '/auth/register', { username: '无密码用户' });
    if (noPw.status !== 400) throw new Error(`expected 400, got ${noPw.status}`);
    const shortPw = await jreq('POST', '/auth/register', { username: '短密码用户', password: '123' });
    if (shortPw.status !== 400) throw new Error(`expected 400 for short password, got ${shortPw.status}`);
  });

  let username;
  await test('POST /auth/register returns user + session token', async () => {
    const { status, data } = await jreq('POST', '/auth/register', { username: '测试学员', password: 'test123456' });
    if (status !== 200 || !data.token) throw new Error(`register failed: ${status}`);
    if (!data.user?.id) throw new Error('no user.id');
    token = data.token;
    userId = data.user.id;
    username = data.user.username;
  });

  await test('GET /auth/me with token returns same user', async () => {
    const { status, data } = await jreq('GET', '/auth/me', null, auth());
    if (status !== 200 || data.id !== userId) throw new Error('user mismatch');
  });

  await test('POST /auth/logout revokes session', async () => {
    const { status } = await jreq('POST', '/auth/logout', null, auth());
    if (status !== 200) throw new Error(`logout failed: ${status}`);
    const after = await jreq('GET', '/auth/me', null, auth());
    if (after.status !== 401) throw new Error('token still valid after logout');
  });

  // 60-agent round-2 #10: login must not leak username existence (unified 401
  // body) and lockout must be per-(IP,account), not account-wide (remote
  // lockout DoS).
  await test('login error is unified — no username enumeration', async () => {
    const noUser = await jreq('POST', '/auth/login', { username: `不存在_${Date.now() % 100000}`, password: 'whatever123' });
    if (noUser.status !== 401) throw new Error(`expected 401 for unknown user, got ${noUser.status}`);
    const wrongPw = await jreq('POST', '/auth/login', { username, password: 'wrongpass999' });
    if (wrongPw.status !== 401) throw new Error(`expected 401 for wrong pw, got ${wrongPw.status}`);
    if (noUser.data?.error !== '用户名或密码错误') throw new Error(`enumeration leak: ${JSON.stringify(noUser.data)}`);
    if (noUser.data?.error !== wrongPw.data?.error) throw new Error('different bodies leak username existence');
  });

  await test('5 failed logins throttle the source; another account is unaffected', async () => {
    const reg = await jreq('POST', '/auth/register', { username: `锁_${Date.now() % 100000}`, password: 'lock123456' });
    if (reg.status !== 200) throw new Error('register failed');
    const lockedName = reg.data.user.username;
    let last;
    for (let i = 0; i < 5; i++) {
      last = await jreq('POST', '/auth/login', { username: lockedName, password: `bad${i}` });
    }
    if (last.status !== 401) throw new Error(`5th wrong login should be 401, got ${last.status}`);
    const sixth = await jreq('POST', '/auth/login', { username: lockedName, password: 'lock123456' });
    if (sixth.status !== 429) throw new Error(`6th login (correct pw) should 429, got ${sixth.status}`);
    // A DIFFERENT account from the same IP must be unaffected — lockout is
    // per-(IP,account), not account-wide (would-be remote DoS regression).
    const other = await jreq('POST', '/auth/login', { username, password: 'test123456' });
    if (other.status !== 200) throw new Error(`different account blocked (account-wide lockout regression): ${other.status}`);
  });

  // Register a second user for the remaining authed tests (session revoked above).
  await test('re-register (fresh session) for subsequent tests', async () => {
    const { data } = await jreq('POST', '/auth/register', { username: `学员${Date.now() % 100000}`, password: 'pw123456' });
    token = data.token;
    userId = data.user.id;
  });

  // ─── 60-agent #7: username normalization + session revocation ───
  // NFKC folds full-width ａｌｉｃｅ → ascii alice; zero-width/control chars are
  // stripped, so an invisible-variant registration must be impossible. This is
  // the regression that keeps visually-impersonating accounts from slipping
  // past the UNIQUE index.
  await test('NFKC: full-width username registers as ascii; both forms log in', async () => {
    const fw = `ｆｕｌｌ${Date.now() % 100000}`; // full-width latin, folds to ascii
    const reg = await jreq('POST', '/auth/register', { username: fw, password: 'nfkc123456' });
    if (reg.status !== 200) throw new Error(`full-width register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
    const stored = reg.data.user.username;
    if (stored !== fw.normalize('NFKC')) throw new Error(`username not NFKC-normalized: "${stored}"`);
    const asciiLogin = await jreq('POST', '/auth/login', { username: stored, password: 'nfkc123456' });
    if (asciiLogin.status !== 200) throw new Error(`ascii-form login failed: ${asciiLogin.status}`);
    const fwLogin = await jreq('POST', '/auth/login', { username: fw, password: 'nfkc123456' });
    if (fwLogin.status !== 200) throw new Error(`full-width-form login failed: ${fwLogin.status}`);
  });

  await test('zero-width impostor of an existing username is rejected (409)', async () => {
    const ts = Date.now() % 100000; // one suffix so both forms normalize identically
    const base = `alice${ts}`;
    const first = await jreq('POST', '/auth/register', { username: base, password: 'alice123456' });
    if (first.status !== 200) throw new Error('base register failed');
    // Insert an invisible ZWSP inside the same visual name — normalization must
    // strip it, making this a duplicate → 409 (no visually-identical clone).
    const zwsp = `a${'​'}lice${ts}`;
    const imp = await jreq('POST', '/auth/register', { username: zwsp, password: 'evil123456' });
    if (imp.status !== 409) throw new Error(`ZWSP variant not rejected: ${imp.status} ${JSON.stringify(imp.data)}`);
  });

  await test('logout-all revokes EVERY session for the user', async () => {
    const reg = await jreq('POST', '/auth/register', { username: `多会话${Date.now() % 100000}`, password: 'multi123456' });
    if (reg.status !== 200) throw new Error('register failed');
    const t1 = reg.data.token;
    const l2 = await jreq('POST', '/auth/login', { username: reg.data.user.username, password: 'multi123456' });
    const t3 = await jreq('POST', '/auth/login', { username: reg.data.user.username, password: 'multi123456' });
    if (l2.status !== 200 || t3.status !== 200) throw new Error('second sessions failed');
    const close = await jreq('POST', '/auth/logout-all', null, { 'Content-Type': 'application/json', Authorization: `Bearer ${t1}` });
    if (close.status !== 200) throw new Error(`logout-all failed: ${close.status}`);
    for (const [name, tok] of [['t1', t1], ['t2', l2.data.token], ['t3', t3.data.token]]) {
      const me = await jreq('GET', '/auth/me', null, { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` });
      if (me.status !== 401) throw new Error(`${name} still valid after logout-all: ${me.status}`);
    }
  });

  await test('change-password revokes all sessions; new pw works, old pw dies', async () => {
    const reg = await jreq('POST', '/auth/register', { username: `改密${Date.now() % 100000}`, password: 'old123456' });
    if (reg.status !== 200) throw new Error('register failed');
    const oldTok = reg.data.token;
    const s2 = await jreq('POST', '/auth/login', { username: reg.data.user.username, password: 'old123456' });
    if (s2.status !== 200) throw new Error('second session failed');
    const chg = await jreq('POST', '/auth/change-password', { oldPassword: 'old123456', newPassword: 'new123456' },
      { 'Content-Type': 'application/json', Authorization: `Bearer ${oldTok}` });
    if (chg.status !== 200) throw new Error(`change-password failed: ${chg.status} ${JSON.stringify(chg.data)}`);
    for (const [name, tok] of [['primary', oldTok], ['second', s2.data.token]]) {
      const me = await jreq('GET', '/auth/me', null, { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` });
      if (me.status !== 401) throw new Error(`${name} token still valid after password change: ${me.status}`);
    }
    const newLogin = await jreq('POST', '/auth/login', { username: reg.data.user.username, password: 'new123456' });
    if (newLogin.status !== 200) throw new Error(`new password login failed: ${newLogin.status}`);
    const oldLogin = await jreq('POST', '/auth/login', { username: reg.data.user.username, password: 'old123456' });
    if (oldLogin.status !== 401) throw new Error(`old password still accepted: ${oldLogin.status}`);
  });

  // Sliding renewal: an active session that is about to expire must be extended
  // to ~30 days again on use — otherwise a learner returning after >30 days is
  // silently logged out with their progress stranded (the old data-loss path).
  await test('session sliding renewal extends a nearly-expired session', async () => {
    const db = new Database(DB_PATH);
    db.pragma('busy_timeout = 5000');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    // Force this session to be valid-but-dying (10 minutes left).
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .run(new Date(Date.now() + 10 * 60 * 1000).toISOString(), hash);
    const me = await jreq('GET', '/auth/me', null, auth());
    if (me.status !== 200) throw new Error(`/auth/me failed: ${me.status}`);
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash);
    db.close();
    const renewed = new Date(row.expires_at).getTime();
    if (renewed < Date.now() + 29 * 24 * 3600 * 1000) {
      throw new Error(`session not renewed: expires_at=${row.expires_at}`);
    }
  });

  // ─── Courses (public) ───
  console.log('\n📋 Courses');
  await test('GET /courses returns course list with both courses', async () => {
    const { data } = await jreq('GET', '/courses');
    if (!Array.isArray(data) || data.length === 0) throw new Error('empty course list');
    if (!data.some(c => c.id === 'electrician_basics')) throw new Error('electrician_basics missing');
    if (!data.some(c => c.id === 'electrician_prereq')) throw new Error('electrician_prereq missing');
  });

  let unitLessons;
  await test('GET /courses/:id/units/:uid returns unit with lessons', async () => {
    const { status, data } = await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics');
    if (status !== 200 || !Array.isArray(data.lessons) || data.lessons.length < 5)
      throw new Error(`expected >=5 lessons, got ${data.lessons?.length}`);
    unitLessons = data.lessons;
  });

  const l1 = unitLessons.find(l => l.id === 'l1_intro');
  const l2 = unitLessons.find(l => l.id === 'l2_battery');
  await test('GET lesson: l1_intro returns question nodes (auth-gated)', async () => {
    const { status, data } = await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro', null, auth());
    if (status !== 200 || !Array.isArray(data.nodes) || data.nodes.length === 0)
      throw new Error(`status=${status}, no nodes`);
  });

  // Lesson payloads carry answer keys → now auth-gated (60-agent round 2).
  await test('GET lesson without token → 401 (no anonymous answer-key leak)', async () => {
    const { status } = await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro');
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });

  // ─── Game Mechanics ───
  console.log('\n📋 Game Mechanics');
  await test('GET /game/state (fresh) → hearts 5, coins 500', async () => {
    const { status, data } = await jreq('GET', '/game/state', null, auth());
    if (status !== 200 || data.hearts !== 5 || data.coins !== 500)
      throw new Error(`expected hearts=5 coins=500, got ${data.hearts}/${data.coins}`);
  });

  await test('POST /game/use-heart → 4 hearts', async () => {
    const { data } = await jreq('POST', '/game/use-heart', {}, auth());
    if (data.hearts !== 4) throw new Error(`got ${data.hearts}`);
  });

  await test('POST /game/restore-heart → 5, then immediate repeat → 429 cooldown', async () => {
    const first = await jreq('POST', '/game/restore-heart', { amount: 1 }, auth());
    if (first.status !== 200 || first.data.hearts !== 5)
      throw new Error(`expected 200/hearts=5, got ${first.status}/${first.data?.hearts}`);
    // Cooldown gate: hammering restore-heart can no longer farm free hearts.
    const second = await jreq('POST', '/game/restore-heart', { amount: 1 }, auth());
    if (second.status !== 429) throw new Error(`expected 429 cooldown, got ${second.status}`);
  });

  // Server pricing: client sends amount:1 but freeze_block costs 200.
  await test('POST /game/spend-coins uses SERVER price (500 → 300)', async () => {
    const { status, data } = await jreq('POST', '/game/spend-coins', { itemId: 'freeze_block', amount: 1 }, auth());
    if (status !== 200 || data.coins !== 300) throw new Error(`expected 300, got ${data.coins}`);
  });

  await test('POST /game/spend-coins second purchase (300 → 100)', async () => {
    const { data } = await jreq('POST', '/game/spend-coins', { itemId: 'freeze_block' }, auth());
    if (data.coins !== 100) throw new Error(`expected 100, got ${data.coins}`);
  });

  await test('POST /game/spend-coins insufficient → 400', async () => {
    const { status } = await jreq('POST', '/game/spend-coins', { itemId: 'freeze_block' }, auth());
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

  await test('POST /game/spend-coins unknown item → 400', async () => {
    const { status } = await jreq('POST', '/game/spend-coins', { itemId: 'not_a_real_item' }, auth());
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

  await test('POST /game/checkin increments streak', async () => {
    const { data } = await jreq('POST', '/game/checkin', null, auth());
    if (!data || data.streak < 1) throw new Error(`streak=${data?.streak}`);
  });

  await test('GET /game/mistakes initially empty', async () => {
    const { status, data } = await jreq('GET', '/game/mistakes', null, auth());
    if (status !== 200 || !Array.isArray(data.mistakes) || data.mistakes.length !== 0)
      throw new Error('expected empty mistakes');
  });

  await test('GET /game/leaderboard/bronze returns entries array', async () => {
    const { status, data } = await jreq('GET', '/game/leaderboard/bronze', null, auth());
    if (status !== 200 || !Array.isArray(data.entries) || data.entries.length === 0)
      throw new Error('expected entries array');
  });

  // ─── Path traversal hardening (C3: loadUnit whitelist) ───
  console.log('\n📋 Path Traversal');
  await test('traversal in courseId/unitId/lessonId rejected (404, not file content)', async () => {
    const attempts = [
      '/courses/..%2f..%2fpackage',
      '/courses/electrician_basics/units/..%2f..%2fpackage',
      '/courses/electrician_basics/units/u1_meter_basics/lessons/..%2f..%2fpackage',
      '/courses/..%2F..%2F..%2Fetc%2Fpasswd',
      '/courses/electrician_basics/units/%2e%2e/lessons/x',
    ];
    for (const url of attempts) {
      // 401 (auth-gated now) and 404 (whitelist) are both rejections — the
      // security property is "never file content", not a specific status.
      const { status } = await jreq('GET', url);
      if (status !== 404 && status !== 401) throw new Error(`${url} → ${status}, expected 401/404`);
    }
    // Unknown-but-shaped ids also reject (whitelist enforced / auth-gated).
    const { status } = await jreq('GET', '/courses/electrician_basics/units/not_a_unit/lessons/x');
    if (status !== 404 && status !== 401) throw new Error(`unknown unit → ${status}, expected 401/404`);
  });

  // ─── Lesson Completion (server-side grading) ───
  console.log('\n📋 Lesson Completion');
  await test('complete l1_intro all-correct → accuracy 100, xp +15, coins +5', async () => {
    const lesson = (await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro', null, auth())).data;
    const { status, data } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro/complete',
      { answers: buildAnswers(lesson) }, auth()
    );
    if (status !== 200) throw new Error(`complete failed ${status}: ${JSON.stringify(data)}`);
    if (data.accuracy !== 100) throw new Error(`accuracy=${data.accuracy}`);
    if (!data.rewards || data.rewards.xpEarned !== 15) throw new Error(`xp=${data.rewards?.xpEarned}`);
    if (data.rewards.coinsEarned !== 5) throw new Error(`coins=${data.rewards?.coinsEarned}`);
  });

  await test('complete l1_intro again (repeat) → review bonus, no coins', async () => {
    const lesson = (await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro', null, auth())).data;
    const { data } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro/complete',
      { answers: buildAnswers(lesson) }, auth()
    );
    if (!data.rewards.repeat) throw new Error('not marked repeat');
    // xp 可能被首次 100% 触发的 30% 概率翻倍(2.0x)，故允许 {2,4}
    if (![2, 4].includes(data.rewards.xpEarned)) throw new Error(`repeat xp=${data.rewards.xpEarned}`);
    if (data.rewards.coinsEarned !== 0) throw new Error(`repeat coins=${data.rewards.coinsEarned}`);
  });

  await test('complete l2_battery with one wrong → mistakes recorded, accuracy < 100', async () => {
    const lesson = (await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery', null, auth())).data;
    const { status, data } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: buildAnswers(lesson, 0) }, auth()
    );
    if (status !== 200) throw new Error(`complete failed: ${JSON.stringify(data)}`);
    if (data.accuracy >= 100) throw new Error(`accuracy=${data.accuracy}, expected < 100`);
    if (!data.mistakesCount || data.mistakesCount < 1) throw new Error('no mistakes recorded');
  });

  await test('empty-answer submission → 0 XP, lesson stays uncompleted', async () => {
    const { data: fresh } = await jreq('POST', '/auth/register', { username: `空答案${Date.now() % 100000}`, password: 'pw123456' });
    const fAuth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${fresh.token}` });
    const lesson = (await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery', null, fAuth())).data;
    const { status, data } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: [] }, fAuth()
    );
    if (status !== 200) throw new Error(`complete failed ${status}`);
    if (data.rewards?.xpEarned !== 0) throw new Error(`empty answers should earn 0 XP, got ${data.rewards?.xpEarned}`);
    if (data.rewards?.passed) throw new Error('empty answers must not pass');
    if (data.progress?.completed === 1) throw new Error('empty answers must not mark lesson completed');
  });

  await test('completed is MONOTONIC: sub-80 retry never downgrades a passed lesson', async () => {
    const { data: fresh } = await jreq('POST', '/auth/register', { username: `单调${Date.now() % 100000}`, password: 'pw123456' });
    const fAuth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${fresh.token}` });
    const lesson = (await jreq('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery', null, fAuth())).data;
    // All-wrong payload: '' fails every gradeable type (C2: server re-grades, no
    // client claim to trust). Guaranteed < 80%, so the re-attempt must NOT pass.
    const allWrong = lesson.nodes
      .filter(n => n.type !== 'info')
      .map(n => ({ nodeId: n.id, nodeIndex: lesson.nodes.indexOf(n), userAnswer: '' }));
    // 1) 100% pass → completed=1
    const first = await jreq('POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: buildAnswers(lesson) }, fAuth());
    if (first.status !== 200 || first.data.progress?.completed !== 1)
      throw new Error(`first pass must complete: ${first.status} ${JSON.stringify(first.data.progress)}`);
    // 2) all-wrong retry → accuracy 0, but completed MUST stay 1 (C2 monotonic
    //    `wasCompleted || passed` — otherwise pass/fail alternation re-mints
    //    first-completion coins forever).
    const retry = await jreq('POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: allWrong }, fAuth());
    if (retry.status !== 200) throw new Error(`retry failed ${retry.status}: ${JSON.stringify(retry.data)}`);
    if (retry.data.accuracy >= 80) throw new Error(`all-wrong should score <80, got ${retry.data.accuracy}`);
    if (retry.data.progress?.completed !== 1)
      throw new Error(`completed downgraded to ${retry.data.progress?.completed} after sub-80 retry (must stay monotonic)`);
    if (retry.data.rewards?.repeat !== true) throw new Error('re-attempt after a pass must be marked repeat (no re-mint)');
    // 3) GET /progress agrees — the lesson is still completed (no silent count drop)
    const prog = await jreq('GET', '/courses/progress', null, fAuth());
    const row = (prog.data || []).find(p => p.lesson_id === 'electrician_basics/u1_meter_basics/l2_battery');
    if (!row || row.completed !== 1) throw new Error(`progress row lost completed flag: ${JSON.stringify(row)}`);
  });

  await test('malformed answers → clean 400 (no 500 / no SQL leak)', async () => {
    const { status: s1, data: d1 } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: [{ nodeId: { $evil: 'obj' }, nodeIndex: 0, userAnswer: 'x' }] }, auth()
    );
    if (s1 !== 400) throw new Error(`object nodeId should be 400, got ${s1}`);
    if (String(d1?.error).toLowerCase().includes('no such table') || /sql/i.test(String(d1?.error)))
      throw new Error(`error leaks internals: ${JSON.stringify(d1)}`);
    const { status: s2, data: d2 } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: [{ nodeId: 'n1', nodeIndex: '0', userAnswer: 'x' }] }, auth()
    );
    if (s2 !== 400) throw new Error(`string nodeIndex should be 400, got ${s2}`);
    const { status: s3 } = await jreq(
      'POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: ['not-an-object'] }, auth()
    );
    if (s3 !== 400) throw new Error(`non-object entry should be 400, got ${s3}`);
  });

  await test('mistakes now appear in review queue', async () => {
    const { data } = await jreq('GET', '/game/mistakes', null, auth());
    if (!Array.isArray(data.mistakes) || data.mistakes.length < 1) throw new Error('expected >= 1 mistake');
  });

  // ─── P0 D Telemetry: node_results written in grading txn ───
  await test('node_results recorded for correct AND wrong nodes (p-value source)', async () => {
    const db = new Database(DB_PATH);
    db.pragma('busy_timeout = 5000');
    // l1_intro was completed all-correct; l2_battery with one wrong. Both should
    // have node_results rows — including the correct ones (previously discarded).
    const l1 = db.prepare(`
      SELECT COUNT(*) c, SUM(correct) correct
      FROM node_results WHERE lesson_id = 'electrician_basics/u1_meter_basics/l1_intro' AND user_id = ?
    `).get(userId);
    if (!l1.c || l1.c < 1) throw new Error(`l1_intro: no node_results rows`);
    if (l1.correct !== l1.c) throw new Error(`l1_intro: correct=${l1.correct}/${l1.c}, expected all correct`);
    const l2 = db.prepare(`
      SELECT COUNT(*) c, SUM(correct) correct
      FROM node_results WHERE lesson_id = 'electrician_basics/u1_meter_basics/l2_battery' AND user_id = ?
    `).get(userId);
    if (!l2.c || l2.c < 1) throw new Error(`l2_battery: no node_results rows`);
    if (l2.correct >= l2.c) throw new Error(`l2_battery: expected >= 1 wrong, got ${l2.correct}/${l2.c}`);
    // getNodeStats aggregate returns a per-node difficulty view
    const stats = db.prepare(`
      SELECT node_id, ROUND(100.0*SUM(correct)/COUNT(*),1) pct
      FROM node_results WHERE lesson_id = ? GROUP BY node_id
    `).all('electrician_basics/u1_meter_basics/l2_battery');
    if (!stats.some(s => Number(s.pct) < 100)) throw new Error('expected a node with pct < 100');
    db.close();
  });

  // ─── P0 F SM-2 closed loop hardening ───
  await test('orphaned mistake card is dismissed (not rescheduled forever)', async () => {
    const db = new Database(DB_PATH);
    db.pragma('busy_timeout = 5000');
    // Insert a mistake pointing to a node that no longer exists in course data.
    db.prepare(`
      INSERT INTO mistakes (user_id, lesson_id, node_id, node_index, question_text, user_answer, correct_answer,
        next_review_date, easiness, interval_days, review_count, mastered)
      VALUES (?, 'electrician_basics/u1_meter_basics/l2_battery', 'node_that_no_longer_exists', 999,
        '这个节点已不存在', '旧答案', '正确答案', ?, 2.5, 0, 0, 0)
    `).run(userId, '2026-08-14');
    const orphan = db.prepare('SELECT id FROM mistakes WHERE node_id = ?').get('node_that_no_longer_exists');
    db.close();
    if (!orphan) throw new Error('failed to seed orphan mistake');
    const { status, data } = await jreq('POST', '/game/mistakes/review',
      { mistakeId: orphan.id, userAnswer: '随便什么答案' }, auth());
    if (status !== 200) throw new Error(`review failed: ${status}`);
    if (!data.dismissed) throw new Error('orphan card not dismissed');
    if (!data.mistake.mastered) throw new Error('orphan card not marked mastered');
    const db2 = new Database(DB_PATH);
    const mastered = db2.prepare('SELECT mastered FROM mistakes WHERE id = ?').get(orphan.id);
    db2.close();
    if (mastered.mastered !== 1) throw new Error('orphan card not mastered in DB');
  });

  await test('practice-heal caps at 20 credits, surplus stays unclaimed', async () => {
    const db = new Database(DB_PATH);
    db.pragma('busy_timeout = 5000');
    // Seed 25 unclaimed credits with unique fake mistake_ids.
    const ins = db.prepare('INSERT OR IGNORE INTO review_credit (user_id, mistake_id) VALUES (?, ?)');
    for (let i = 0; i < 25; i++) ins.run(userId, 900000 + i);
    const seeded = db.prepare('SELECT COUNT(*) c FROM review_credit WHERE user_id = ? AND claimed = 0').get(userId).c;
    if (seeded < 25) throw new Error(`seeded ${seeded} credits, expected 25`);
    db.close();
    const { status, data } = await jreq('POST', '/game/practice-heal', {}, auth());
    if (status !== 200) throw new Error(`practice-heal failed: ${status}`);
    if (data.coinsEarned !== 200) throw new Error(`coinsEarned=${data.coinsEarned}, expected 200 (20x10)`);
    const db2 = new Database(DB_PATH);
    const remaining = db2.prepare('SELECT COUNT(*) c FROM review_credit WHERE user_id = ? AND claimed = 0').get(userId).c;
    db2.close();
    if (remaining < 5) throw new Error(`expected >= 5 credits to remain unclaimed, got ${remaining}`);
  });

  // ─── Progress (was shadowed by /:courseId — route must be registered first) ───
  console.log('\n📋 Progress');
  await test('GET /courses/progress requires auth (401)', async () => {
    const { status } = await jreq('GET', '/courses/progress');
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });

  await test('GET /courses/progress returns completed lessons', async () => {
    const { status, data } = await jreq('GET', '/courses/progress', null, auth());
    if (status !== 200) throw new Error(`expected 200, got ${status}`);
    if (!Array.isArray(data) || data.length === 0) throw new Error('expected progress rows');
    const l1 = data.find(p => p.lesson_id === 'electrician_basics/u1_meter_basics/l1_intro');
    if (!l1 || l1.completed !== 1) throw new Error('l1_intro not marked completed');
  });

  // ─── Mock exam engine (P1) ───
  let examToken = null;
  {
    const { data } = await jreq('POST', '/auth/register', { username: `考生${Date.now() % 100000}`, password: 'exam123456' });
    examToken = data.token;
    if (!examToken) throw new Error('exam user register failed');
    const examAuth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${examToken}` });
    const examAuthHeaders = examAuth();

    await test('POST /exam/start 全真模式(默认) → 100题 60判断/40单选/0多选，无答案泄漏', async () => {
      const { status, data } = await jreq('POST', '/exam/start', {}, examAuthHeaders);
      if (status !== 200) throw new Error(`expected 200, got ${status}: ${JSON.stringify(data).slice(0,120)}`);
      if (data.total !== 100) throw new Error(`expected 100 questions, got ${data.total}`);
      if (data.mode !== 'real' || data.minutes !== 120) throw new Error(`expected real/120min, got mode=${data.mode} min=${data.minutes}`);
      const byType = {};
      for (const q of data.questions) byType[q.type] = (byType[q.type] || 0) + 1;
      if (byType.true_false !== 60 || byType.multiple_choice !== 40 || (byType.multi_select || 0) !== 0)
        throw new Error(`real-mode composition wrong: ${JSON.stringify(byType)}`);
      const leaked = data.questions.some(q =>
        q.correct_answer !== undefined || q.explanation !== undefined ||
        (q.options || []).some(o => o.is_correct !== undefined));
      if (leaked) throw new Error('sanitized questions leaked correct answers');
    });

    await test('POST /exam/start mode=training → 60判断/30单选/10多选/45min（训练保留）', async () => {
      const { status, data } = await jreq('POST', '/exam/start', { mode: 'training' }, examAuthHeaders);
      if (status !== 200) throw new Error(`expected 200, got ${status}`);
      if (data.mode !== 'training' || data.minutes !== 45) throw new Error(`expected training/45min, got mode=${data.mode} min=${data.minutes}`);
      const byType = {};
      for (const q of data.questions) byType[q.type] = (byType[q.type] || 0) + 1;
      if (byType.true_false !== 60 || byType.multiple_choice !== 30 || byType.multi_select !== 10)
        throw new Error(`training composition wrong: ${JSON.stringify(byType)}`);
    });

    await test('POST /exam/submit all-wrong → low score, not passed, mistakes ingested', async () => {
      const { data: start } = await jreq('POST', '/exam/start', {}, examAuthHeaders);
      const answers = start.questions.map(q => ({ index: q.index, userAnswer: '绝不会是正确答案的乱填串' }));
      const { status, data } = await jreq('POST', '/exam/submit', { sessionId: start.sessionId, answers }, examAuthHeaders);
      if (status !== 200) throw new Error(`submit expected 200, got ${status}`);
      if (data.score >= 80 || data.passed) throw new Error(`expected fail, got score=${data.score} passed=${data.passed}`);
      if (data.xpEarned !== 0) throw new Error(`all-wrong exam should earn 0 XP, got ${data.xpEarned}`);
      const m = await jreq('GET', '/game/mistakes/due-count', null, examAuthHeaders);
      if (!(m.data.dueCount > 0)) throw new Error(`expected mistakes ingested, got ${m.data.dueCount}`);
    });

    await test('POST /exam/submit re-submit same session → 409', async () => {
      const { data: start } = await jreq('POST', '/exam/start', {}, examAuthHeaders);
      const answers = start.questions.map(q => ({ index: q.index, userAnswer: '错' }));
      await jreq('POST', '/exam/submit', { sessionId: start.sessionId, answers }, examAuthHeaders);
      const again = await jreq('POST', '/exam/submit', { sessionId: start.sessionId, answers }, examAuthHeaders);
      if (again.status !== 409) throw new Error(`expected 409 on re-submit, got ${again.status}`);
    });

    await test('POST /exam/start again expires the old active session (409 on old submit)', async () => {
      const { data: s1 } = await jreq('POST', '/exam/start', {}, examAuthHeaders);
      const { data: s2 } = await jreq('POST', '/exam/start', {}, examAuthHeaders);
      if (!s1.sessionId || !s2.sessionId) throw new Error('missing session ids');
      const answers = s1.questions.map(q => ({ index: q.index, userAnswer: '错' }));
      const old = await jreq('POST', '/exam/submit', { sessionId: s1.sessionId, answers }, examAuthHeaders);
      if (old.status !== 409) throw new Error(`expected old session expired → 409, got ${old.status}`);
    });
  }

  // ─── Summary ───
  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  if (errors.length > 0) {
    console.log('Failures:');
    errors.forEach(e => console.log(e));
  }

  server.kill();
  return failed === 0;
}

// 3998 orphan pollution: a crashed run (uncaught rejection, Ctrl+C, hard kill)
// used to leave its server child bound to 3998, EADDRINUSE-ing every later run
// until someone manually killed it. Always reap the child on process exit, and
// never let an unhandled rejection bypass the kill at the end of run().
process.on('exit', () => { try { server.kill(); } catch {} });
run().then(success => {
  if (!success) process.exit(1);
  process.exit(0);
}).catch(e => {
  console.error('FATAL:', e);
  try { server.kill(); } catch {}
  process.exit(1);
});
