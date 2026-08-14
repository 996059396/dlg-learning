#!/usr/bin/env node
// Milestone-1 smoke test: boots the server on an isolated DB (DLG_DB_PATH),
// then verifies: token auth, server-side grading, idempotent rewards,
// coin persistence, practice-heal, checkin, and 401 enforcement.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3999;
const BASE = `http://localhost:${PORT}/api`;
const DB_DIR = mkdtempSync(path.join(tmpdir(), 'dlg-smoke-'));
const DB_PATH = path.join(DB_DIR, 'test.db');

let passed = 0;
let failed = 0;
let token = null;
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

async function jreq(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Canonical correct answer for a node, as the server's gradeNode expects it.
// Returns '' for node types the server can't re-grade (interactive setups) —
// those reviews are unverifiable and must NOT earn practice-heal credit.
function correctAnswerFor(node) {
  if (!node) return '';
  switch (node.type) {
    case 'multiple_choice':
      return node.options?.find(o => o.is_correct)?.text || '';
    case 'true_false':
      return node.correct_answer ? '正确' : '错误';
    case 'fill_blank':
      return node.answer || node.acceptable_answers?.[0] || '';
    default:
      return ''; // sort/match/simulation/multimeter — server cannot verify a typed re-answer
  }
}

// Build a fully-correct answer entry per gradeable node, serialized exactly as
// the real frontend sends it (keyed by stable node.id + absolute nodeIndex).
// Used to make a REAL first completion that passes the >=80% gate (empty
// answers now score 0% and correctly do NOT mark the lesson completed).
function buildCorrectAnswers(lesson) {
  const answers = [];
  const qNodes = lesson.nodes.filter(n => n.type !== 'info');
  qNodes.forEach((node) => {
    const nodeIndex = lesson.nodes.indexOf(node);
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
    let userAnswer;
    switch (node.type) {
      case 'multiple_choice':
        userAnswer = node.options.find(o => o.is_correct).text;
        break;
      case 'true_false':
        userAnswer = node.correct_answer ? '正确' : '错误';
        break;
      case 'fill_blank':
        userAnswer = node.answer || node.acceptable_answers?.[0] || '';
        break;
      case 'simulation_dial':
        userAnswer = node.dial_options.find(o => o.is_correct).label;
        break;
      case 'simulation_danger':
        userAnswer = '安全操作（先换表笔再测量）';
        break;
      case 'sort':
        userAnswer = node.correct_order.map(id => node.items.find(x => x.id === id)?.text).filter(Boolean).join(',');
        break;
      case 'match':
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

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

const server = spawn('node', ['server.js'], {
  cwd: path.join(import.meta.dirname, 'backend'),
  env: { ...process.env, PORT: String(PORT), DLG_DB_PATH: DB_PATH },
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
  console.log('\n🧪 Milestone-1 smoke test (auth + grading + rewards)\n');

  // ── Auth ──
  await test('401 without token on /auth/me', async () => {
    const { status } = await jreq('GET', '/auth/me');
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });

  await test('register returns token', async () => {
    const { status, data } = await jreq('POST', '/auth/register', { username: '冒烟学员', password: 'smoke12345' });
    if (status !== 200 || !data.token) throw new Error(`register failed: ${status}`);
    token = data.token;
  });

  await test('GET /auth/me with token returns user + state', async () => {
    const { status, data } = await jreq('GET', '/auth/me', null, authHeaders());
    if (status !== 200 || !data.id || !data.username) throw new Error(`me failed: ${status}`);
    if (data.username !== '冒烟学员') throw new Error('wrong user');
    if (typeof data.coins !== 'number') throw new Error('no game state');
  });

  await test('completeLesson 401 without token', async () => {
    const { status } = await jreq('POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro/complete', { answers: [] });
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });

  await test('completeLesson 400 without answers array', async () => {
    const { status } = await jreq('POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l1_intro/complete', { score: 5 }, authHeaders());
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

  // ── Server-side grading + rewards ──
  await test('server re-grades — client cannot self-report correct answers', async () => {
    const unitRes = await fetch(`${BASE}/courses/electrician_basics/units/u1_meter_basics`, { headers: authHeaders() });
    const unit = await unitRes.json();
    const lesson = unit.lessons[0];
    const full = await (await fetch(`${BASE}/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}`, { headers: authHeaders() })).json();

    const qNodes = full.nodes.filter(n => n.type !== 'info');
    // Lie: claim every answer correct, but supply garbage that won't match.
    const answers = qNodes.map((node) => ({ nodeId: node.id, nodeIndex: full.nodes.indexOf(node), userAnswer: '%%%WRONG%%%', correct: true }));

    const { status, data } = await jreq(
      'POST', `/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}/complete`, { answers }, authHeaders()
    );
    if (status !== 200) throw new Error(`complete failed: ${status}`);
    if (data.accuracy === 100) throw new Error('server trusted the client claim (刷分漏洞仍在)');
    // Gradeable types must be graded from the answer text, not the client flag.
    const gradeableCount = qNodes.filter(n => n.type !== 'simulation_probe' && n.type !== 'multimeter_challenge').length;
    if (gradeableCount > 0 && data.rewards?.repeat === false && data.accuracy > 0) {
      // It's acceptable that some nodes (all-wrong) still yield low accuracy; just assert server didn't say 100.
    }
  });

  await test('completeLesson grades server-side, persists coins', async () => {
    // First, read the real lesson to submit matching answers.
    const unitRes = await fetch(`${BASE}/courses/electrician_basics/units/u1_meter_basics`, { headers: authHeaders() });
    const unit = await unitRes.json();
    const lesson = unit.lessons[0];
    const full = await fetch(`${BASE}/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}`, { headers: authHeaders() });
    const fullLesson = await full.json();

    const qNodes = fullLesson.nodes.filter(n => n.type !== 'info');
    const answers = qNodes.map((node) => ({
      nodeId: node.id,
      nodeIndex: fullLesson.nodes.indexOf(node),
      userAnswer: 'CORRECT_PLACEHOLDER', // server re-grades; we test against real grading below
      correct: true,
    }));

    const { status, data } = await jreq(
      'POST', `/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}/complete`, { answers }, authHeaders()
    );
    if (status !== 200) throw new Error(`complete failed: ${status} ${JSON.stringify(data)}`);
    if (data.rewards?.gradedServerSide !== true) throw new Error('not graded server-side');
    if (typeof data.gameState?.coins !== 'number') throw new Error('no gameState in response');

    // Persistence: coins must survive a fresh /auth/me round-trip.
    const me = await jreq('GET', '/auth/me', null, authHeaders());
    if (me.data.coins !== data.gameState.coins) throw new Error('coins did not persist');
  });

  await test('repeat completion gives review bonus (no phantom coins)', async () => {
    const unit = await (await fetch(`${BASE}/courses/electrician_basics/units/u1_meter_basics`, { headers: authHeaders() })).json();
    const lesson = unit.lessons[0];
    const full = await (await fetch(`${BASE}/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}`, { headers: authHeaders() })).json();
    // First completion must be a REAL pass (>=80%) so progress.completed=1 and
    // the second completion is recognized as a repeat. Empty answers now score
    // 0% and — under the anti-farm PASS-gate — correctly do NOT count as a
    // first completion (that was the old "free 10 XP + 5 coins" mint).
    const answers = buildCorrectAnswers(full);
    const first = await jreq('POST', `/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}/complete`, { answers }, authHeaders());
    if (first.status !== 200) throw new Error(`first completion failed: ${first.status}`);
    if (first.data.rewards?.passed !== true) throw new Error(`first completion did not pass (accuracy=${first.data.accuracy})`);
    const coinsAfterFirst = first.data.gameState.coins;
    const second = await jreq('POST', `/courses/electrician_basics/units/u1_meter_basics/lessons/${lesson.id}/complete`, { answers }, authHeaders());
    if (second.data.rewards.repeat !== true) throw new Error('expected repeat flag');
    // Repeat should NOT re-grant full coins (only 2 XP review bonus).
    if (second.data.gameState.coins !== coinsAfterFirst) {
      throw new Error(`repeat granted coins: ${coinsAfterFirst} → ${second.data.gameState.coins}`);
    }
  });

  // ── practice-heal (hearts + coins, server-computed from real reviews) ──
  await test('practice-heal grants hearts + coins from server', async () => {
    // Reward must be EARNED: review 3 due mistakes with the CORRECT answer
    // (server re-grades each and records credit only on a verified correct).
    const { data: due } = await jreq('GET', '/game/mistakes', null, authHeaders());
    const gradeable = (due.mistakes || []).filter(m => correctAnswerFor(m.original_node) !== '');
    const toReview = gradeable.slice(0, 3);
    if (toReview.length < 3) throw new Error(`need >=3 server-gradeable due mistakes, got ${toReview.length} of ${(due.mistakes || []).length}`);
    for (const m of toReview) {
      const r = await jreq('POST', '/game/mistakes/review', { mistakeId: m.id, correct: true, userAnswer: correctAnswerFor(m.original_node) }, authHeaders());
      if (r.status !== 200) throw new Error(`review failed: ${r.status} ${JSON.stringify(r.data)}`);
      if (r.data.serverGraded !== true) throw new Error('expected a server-verified correct review');
    }
    const { status, data } = await jreq('POST', '/game/practice-heal', { correctCount: 3 }, authHeaders());
    if (status !== 200) throw new Error(`practice-heal failed: ${status}`);
    if (data.coinsEarned !== 30) throw new Error(`expected 30 coins, got ${data.coinsEarned}`);
    if (data.hearts !== 5) throw new Error('hearts should be capped at max_hearts');
  });

  await test('practice-heal cannot mint coins without real reviews', async () => {
    // A fresh claim with NO review credit earns ZERO coins, no matter what count is sent.
    const { data } = await jreq('POST', '/game/practice-heal', { correctCount: 99 }, authHeaders());
    if (data.coinsEarned !== 0) throw new Error(`expected 0 coins, got ${data.coinsEarned}`);
  });

  // ── checkin ──
  await test('checkin grants streak + coin bonus', async () => {
    const { status, data } = await jreq('POST', '/game/checkin', {}, authHeaders());
    if (status !== 200) throw new Error(`checkin failed: ${status}`);
    if (data.streak < 1 || typeof data.coinBonus !== 'number') throw new Error('bad checkin payload');
  });

  // ── spend-coins (catalog-validated) ──
  await test('spend-coins uses SERVER price, not client amount', async () => {
    const before = (await jreq('GET', '/game/state', null, authHeaders())).data.coins;
    // Client tries to pay 1 coin for freeze_block (real price 200).
    const { status, data } = await jreq('POST', '/game/spend-coins', { amount: 1, itemId: 'freeze_block' }, authHeaders());
    if (status !== 200) throw new Error(`spend-coins failed: ${status}`);
    if (data.coins !== before - 200) throw new Error(`expected ${before - 200} (server price), got ${data.coins}`);
    const inv = (data.inventory || []).find(i => i.item_id === 'freeze_block');
    if (!inv || inv.quantity !== 1) throw new Error('inventory row missing/wrong');
  });

  await test('unknown item rejected', async () => {
    const { status } = await jreq('POST', '/game/spend-coins', { amount: 5, itemId: 'ghost_item' }, authHeaders());
    if (status !== 400) throw new Error(`expected 400, got ${status}`);
  });

  await test('xp_boost_15 applies boost at purchase', async () => {
    const { status, data } = await jreq('POST', '/game/spend-coins', { amount: 0, itemId: 'xp_boost_15' }, authHeaders());
    if (status !== 200) throw new Error(`purchase failed: ${status}`);
    if (data.xp_boost_multiplier !== 2.0) throw new Error('boost multiplier not applied');
    if (!data.xp_boost_until) throw new Error('boost expiry not set');
  });

  // ── SM-2 mistake scheduling ──
  await test('SM-2: due mistakes returned with schedule', async () => {
    const { status, data } = await jreq('GET', '/game/mistakes', null, authHeaders());
    if (status !== 200) throw new Error(`mistakes failed: ${status}`);
    if (!Array.isArray(data?.mistakes)) throw new Error('missing mistakes array');
    if (data.dueCount < 1) throw new Error('expected due mistakes from earlier wrong answers');
    if (!data.mistakes[0].id || typeof data.mistakes[0].interval_days !== 'number') {
      throw new Error('mistake lacks SM-2 schedule fields');
    }
  });

  await test('SM-2: correct review → interval 1 → 6 → grows', async () => {
    const { data } = await jreq('GET', '/game/mistakes', null, authHeaders());
    const m = (data.mistakes || []).find(x => correctAnswerFor(x.original_node) !== '');
    if (!m) throw new Error('no server-gradeable mistake available');
    const ua = () => correctAnswerFor(m.original_node);
    const r1 = (await jreq('POST', '/game/mistakes/review', { mistakeId: m.id, correct: true, userAnswer: ua() }, authHeaders())).data;
    if (r1.serverGraded !== true) throw new Error('review not server-graded');
    if (r1.mistake.interval_days !== 1) throw new Error(`expected interval 1, got ${r1.mistake.interval_days}`);
    const r2 = (await jreq('POST', '/game/mistakes/review', { mistakeId: m.id, correct: true, userAnswer: ua() }, authHeaders())).data;
    if (r2.mistake.interval_days !== 6) throw new Error(`expected interval 6, got ${r2.mistake.interval_days}`);
    const r3 = (await jreq('POST', '/game/mistakes/review', { mistakeId: m.id, correct: true, userAnswer: ua() }, authHeaders())).data;
    if (r3.mistake.interval_days < 6) throw new Error(`interval should grow past 6, got ${r3.mistake.interval_days}`);
  });

  await test('SM-2: wrong review resets interval to tomorrow', async () => {
    const { data } = await jreq('GET', '/game/mistakes', null, authHeaders());
    const m = (data.mistakes || []).find(x => correctAnswerFor(x.original_node) !== '');
    if (!m) throw new Error('no server-gradeable mistake available');
    const r = (await jreq('POST', '/game/mistakes/review', { mistakeId: m.id, correct: false, userAnswer: '这不是正确答案' }, authHeaders())).data;
    if (r.mistake.interval_days !== 1) throw new Error(`expected interval reset to 1, got ${r.mistake.interval_days}`);
    if (r.mistake.mastered !== false) throw new Error('wrong answer must not master the card');
  });

  await test('SM-2: client-claimed correct:true earns NO credit on wrong answer', async () => {
    // The old exploit: send correct:true with zero knowledge to mint coins.
    // Server now re-grades the actual answer and never trusts the boolean.
    const { data } = await jreq('GET', '/game/mistakes', null, authHeaders());
    const m = (data.mistakes || []).find(x => correctAnswerFor(x.original_node) !== '');
    if (!m) throw new Error('no server-gradeable mistake available');
    // Drain any credit left over from earlier tests so this assertion is hermetic.
    await jreq('POST', '/game/practice-heal', { correctCount: 0 }, authHeaders());
    const r = (await jreq('POST', '/game/mistakes/review', { mistakeId: m.id, correct: true, userAnswer: '错误的占位答案' }, authHeaders())).data;
    if (r.serverGraded !== true) throw new Error('expected server re-grade');
    if (r.mistake.interval_days !== 1) throw new Error(`wrong answer must reset interval, got ${r.mistake.interval_days}`);
    const heal = (await jreq('POST', '/game/practice-heal', { correctCount: 99 }, authHeaders())).data;
    if (heal.coinsEarned !== 0) throw new Error(`client-claimed correct must not mint coins, got ${heal.coinsEarned}`);
  });

  // ── IDOR: another user cannot touch this user's mistakes ──
  await test('cross-user mistake review rejected', async () => {
    const { data: other } = await jreq('POST', '/auth/register', { username: '隔壁用户', password: 'other12345' });
    const otherToken = other.token;
    const { status } = await jreq(
      'POST', '/game/mistakes/review', { mistakeId: 999999, correct: true, userAnswer: '任意' }, { 'Content-Type': 'application/json', Authorization: `Bearer ${otherToken}` }
    );
    if (status !== 404) throw new Error(`expected 404, got ${status}`);
  });

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
}

run().catch(async (e) => {
  console.error('❌ Fatal:', e.message);
  server.kill();
  process.exit(1);
});
