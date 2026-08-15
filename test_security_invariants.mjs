#!/usr/bin/env node
// Security-invariant regression suite (crosscheck4 P0-5 / C14 mutation gaps).
// Boots THREE servers on isolated DBs, each holding ONE rate-limit concern so
// buckets never cross-talk:
//   - server A (3998): 错题卡脱敏缺席断言 / 模拟考及格路径 / 多选 remap
//   - server B (3997): register 独立桶边界 (prod 5/15min 不放开) + 409 通用消息体
//   - server C (3996): login-user-global 跨 IP 兜底 (调高 login-user 绕过 per-account 锁)
// plus UNIT checks for rate_limit (过期桶重置 / clearBucket) and
// simulation_danger 负例 ('不安全操作' 含 '安全操作' 子串必须判错).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`[fatal] DLG tests require Node >= 22; got Node ${process.version}. Use C:\\Users\\moxo\\node24\\node.exe`);
  process.exit(1);
}

const req = createRequire(import.meta.url);
const Database = req(path.join(import.meta.dirname, 'backend', 'node_modules', 'better-sqlite3'));

const PORTS = { A: 3998, B: 3997, C: 3996 };
const BASE = {
  A: `http://localhost:${PORTS.A}/api`,
  B: `http://localhost:${PORTS.B}/api`,
  C: `http://localhost:${PORTS.C}/api`,
};
const DB_PATHS = {
  A: path.join(mkdtempSync(path.join(tmpdir(), 'dlg-sec-a-')), 'test.db'),
  B: path.join(mkdtempSync(path.join(tmpdir(), 'dlg-sec-b-')), 'test.db'),
  C: path.join(mkdtempSync(path.join(tmpdir(), 'dlg-sec-c-')), 'test.db'),
};

let passed = 0, failed = 0;
const errors = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; const m = `  ❌ ${name}: ${e.message}`; console.log(m); errors.push(m); }
}

function mkJreq(base) {
  return async (method, url, body, headers = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}
const jA = mkJreq(BASE.A);
const jB = mkJreq(BASE.B);
const jC = mkJreq(BASE.C);
const auth = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

function spawnServer(port, dbPath, extraEnv = {}) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, 'backend'),
    env: {
      ...process.env,
      PORT: String(port),
      DLG_DB_PATH: dbPath,
      // Suite spawns dozens of throwaway accounts; auth-ip scaled up so it never
      // 429s mid-run. register/login-user LEFT AT PROD where the test is ABOUT
      // that bucket's boundary (B registers, C login-user); server A raises
      // register so its own registrations pass.
      'DLG_RATE_MAX_auth-ip': '1000',
      ...extraEnv,
    },
    stdio: 'pipe',
  });
  server.stderr.on('data', d => { if (String(d).includes('Error')) console.error(`[server${port}]`, String(d)); });
  return server;
}

async function waitForServer(base, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

// ─── 复制 test_api 的 buildAnswers 简化版：为 lesson 构造全对(或第 q 个错)答案 ───
function buildAnswers(lesson, wrongQ = -1) {
  const answers = [];
  const questionNodes = lesson.nodes.filter(n => n.type !== 'info');
  questionNodes.forEach((node, q) => {
    const nodeIndex = lesson.nodes.indexOf(node);
    const wrong = q === wrongQ;
    let userAnswer;
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
      case 'simulation_danger':
        userAnswer = wrong ? '不安全操作' : '安全操作（先换表笔再测量）';
        break;
      case 'simulation_probe': {
        const cp = node.correct_probes || {};
        userAnswer = `红:${cp.red},黑:${cp.black}`;
        break;
      }
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

// 深搜 JSON，收集所有出现过的 key，用于脱敏缺席断言。
function collectKeys(obj, acc = new Set()) {
  if (Array.isArray(obj)) { for (const x of obj) collectKeys(x, acc); return acc; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) { acc.add(k); collectKeys(obj[k], acc); }
  }
  return acc;
}

// 构造模拟考全对答案：直接读 DB 的 questions_json（服务端唯一权威真相）。
function buildExamAllCorrect(questions) {
  return questions.map((node, i) => {
    let userAnswer;
    switch (node.type) {
      case 'true_false': userAnswer = node.correct_answer ? '正确' : '错误'; break;
      case 'multiple_choice': userAnswer = node.options.find(o => o.is_correct)?.text || ''; break;
      case 'multi_select': {
        const ids = node.options.filter(o => o.is_correct).map(o => o.id);
        userAnswer = JSON.stringify(ids);
        break;
      }
      default: userAnswer = '';
    }
    return { index: i, userAnswer };
  });
}

// 完成一个 lesson，仅将指定题型答错（其余全对），用于制造目标题型的错题卡。
// 错题入册不依赖 pass>=80（courses.js：任何 server 确认答错的节点都入册），
// 所以即使目标题型全错把 accuracy 拉低，卡也照常生成。
async function completeWithTypesWrong(ea, course, unit, lessonId, wrongTypes) {
  const lesson = (await jA('GET', `/courses/${course}/units/${unit}/lessons/${lessonId}`, null, ea)).data;
  if (!lesson?.nodes) throw new Error(`lesson ${lessonId} 无 nodes`);
  const qn = lesson.nodes.filter(n => n.type !== 'info');
  const answers = qn.map(node => {
    const nodeIndex = lesson.nodes.indexOf(node);
    let userAnswer;
    if (wrongTypes.includes(node.type)) {
      userAnswer = '__故意答错__';
    } else {
      const correct = buildAnswers({ nodes: lesson.nodes }, -1).find(a => a.nodeId === node.id);
      userAnswer = correct ? correct.userAnswer : '';
    }
    return { nodeId: node.id, nodeIndex, userAnswer };
  });
  const done = await jA('POST', `/courses/${course}/units/${unit}/lessons/${lessonId}/complete`, { answers }, ea);
  if (done.status !== 200) throw new Error(`complete ${lessonId} failed: ${JSON.stringify(done.data)}`);
}

async function run() {
  const serverA = spawnServer(PORTS.A, DB_PATHS.A, { 'DLG_RATE_MAX_register': '1000' });
  // B: register 保持 prod 5/15min；C: register 放开但 login-user 调高 (绕过 per-account 锁，让全局桶先触顶)
  const serverB = spawnServer(PORTS.B, DB_PATHS.B);
  const serverC = spawnServer(PORTS.C, DB_PATHS.C, { 'DLG_RATE_MAX_register': '1000', 'DLG_RATE_MAX_login-user': '100' });
  await Promise.all([waitForServer(BASE.A), waitForServer(BASE.B), waitForServer(BASE.C)]);
  console.log('\n🔒 DLG Security-Invariant Regression Suite\n');
  console.log('═'.repeat(50));

  // ═══════════ 1. 错题卡脱敏缺席断言 ═══════════
  console.log('\n📋 错题卡脱敏');
  const BANNED = ['correct_answer', 'answer', 'acceptable_answers', 'explanation', 'correct_order'];
  let mmToken;
  await test('注册+完成带错题 lesson → GET /mistakes 响应绝不含任何答案键', async () => {
    const reg = await jA('POST', '/auth/register', { username: `脱敏${Date.now() % 100000}`, password: 'sec123456' });
    if (reg.status !== 200) throw new Error(`register failed: ${reg.status}`);
    mmToken = reg.data.token;
    const lesson = (await jA('GET', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery', null, auth(mmToken))).data;
    const done = await jA('POST', '/courses/electrician_basics/units/u1_meter_basics/lessons/l2_battery/complete',
      { answers: buildAnswers(lesson, 0) }, auth(mmToken));
    if (done.status !== 200) throw new Error(`complete failed: ${JSON.stringify(done.data)}`);
    const { data } = await jA('GET', '/game/mistakes?limit=30', null, auth(mmToken));
    if (!Array.isArray(data.mistakes) || data.mistakes.length < 1) throw new Error('expected mistakes');
    const keys = collectKeys(data.mistakes);
    for (const b of BANNED) {
      if (keys.has(b)) throw new Error(`脱敏失败: 响应含 "${b}"`);
    }
    // 选项级 is_correct 也不得出现
    const optionKeys = data.mistakes
      .map(m => (m.original_node?.options || []))
      .flat().map(o => Object.keys(o)).flat();
    if (optionKeys.includes('is_correct')) throw new Error('脱敏失败: options[].is_correct 泄漏');
  });

  await test('错题卡含 question/user_answer（可判定的上下文）但无答案', async () => {
    const { data } = await jA('GET', '/game/mistakes?limit=30', null, auth(mmToken));
    const m = data.mistakes[0];
    if (!m.question_text && !m.question) throw new Error('卡片缺题目文本');
    if (!m.original_node?.question && !m.original_node) throw new Error('缺 original_node');
  });

  // ═══════════ 2. register 独立桶边界（server B：prod 5/15min，不放开） ═══════════
  console.log('\n📋 register 独立桶');
  let dupName;
  await test('重复用户名注册 → 409 通用消息体（不泄漏是否已存在）', async () => {
    const suffix = Date.now() % 100000;
    dupName = `查重${suffix}`;
    const first = await jB('POST', '/auth/register', { username: dupName, password: 'reg123456' });
    if (first.status !== 200) throw new Error(`first register ${first.status}`);
    const dup = await jB('POST', '/auth/register', { username: dupName, password: 'reg123456' });
    if (dup.status !== 409) throw new Error(`应 409, got ${dup.status}`);
    if (String(dup.data.error) !== '注册失败，请更换用户名')
      throw new Error(`409 body 泄漏: ${JSON.stringify(dup.data)}`);
  });

  await test('register 桶连打 5 次成功，第 6 次 429（独立桶生效）', async () => {
    // 上一测试已消耗该 IP register 桶 2 次（首次成功 + 409 重试），再补 3 次到 5，第 6 次应 429
    const suffix = Date.now() % 100000;
    for (let i = 0; i < 3; i++) {
      const r = await jB('POST', '/auth/register', { username: `桶${suffix}_${i}`, password: 'reg123456' });
      if (r.status !== 200) throw new Error(`第 ${i + 1} 次 register ${r.status}: ${JSON.stringify(r.data)}`);
    }
    const sixth = await jB('POST', '/auth/register', { username: `桶${suffix}_6`, password: 'reg123456' });
    if (sixth.status !== 429) throw new Error(`第 6 次 register 应 429, got ${sixth.status}`);
  });

  await test('register 桶满不影响 login（auth-ip 独立，未被误伤）', async () => {
    const r = await jB('POST', '/auth/login', { username: dupName, password: 'reg123456' });
    if (r.status !== 200 && r.status !== 401) throw new Error(`login 被 register 桶误伤: ${r.status}`);
  });

  // ═══════════ 3. login-user-global 跨 IP 兜底（server C） ═══════════
  console.log('\n📋 login-user-global 兜底');
  await test('同一用户名错误密码 21 次 → 第 21 次 429（全局兜底 20 生效）', async () => {
    // server C 调高 login-user=100 以绕过 per-account 5 次锁，让全局桶(20)先触顶。
    const target = `全局${Date.now() % 100000}`;
    await jC('POST', '/auth/register', { username: target, password: 'ok123456' });
    let last;
    for (let i = 0; i < 21; i++) {
      last = await jC('POST', '/auth/login', { username: target, password: `bad${i}` });
      if (i < 20 && last.status === 429) throw new Error(`第 ${i + 1} 次不应 429(全局 20), got ${last.status}`);
    }
    if (last.status !== 429) throw new Error(`第 21 次应 429, got ${last.status}`);
  });

  await test('成功登录清零全局桶 → 之后失败不再立刻 429', async () => {
    // 先打 18 次失败（全局桶=18，未触顶，login-user=100 不拦）→ 成功登录应清零
    // login-user 与 login-user-global 桶 → 再打 19 次失败全 401（若未清零，第 2 次就该 429）。
    const target = `清零${Date.now() % 100000}`;
    await jC('POST', '/auth/register', { username: target, password: 'ok123456' });
    for (let i = 0; i < 18; i++) {
      const f = await jC('POST', '/auth/login', { username: target, password: `bad${i}` });
      if (f.status !== 401) throw new Error(`第 ${i + 1} 次应 401, got ${f.status}`);
    }
    const ok = await jC('POST', '/auth/login', { username: target, password: 'ok123456' });
    if (ok.status !== 200) throw new Error(`正确密码登录失败: ${ok.status}`);
    for (let i = 0; i < 19; i++) {
      const f = await jC('POST', '/auth/login', { username: target, password: `x${i}` });
      if (f.status === 429) throw new Error(`清零后第 ${i + 1} 次失败仍 429 (clearBucket 未生效)`);
    }
  });

  // ═══════════ 4. 模拟考及格路径 ═══════════
  console.log('\n📋 模拟考及格路径');
  await test('全对交卷 → score=100/passed/xp30/首过 30 币', async () => {
    const reg = await jA('POST', '/auth/register', { username: `及格${Date.now() % 100000}`, password: 'exam123456' });
    const ea = auth(reg.data.token);
    const start = await jA('POST', '/exam/start', {}, ea);
    if (start.status !== 200) throw new Error(`start failed: ${JSON.stringify(start.data).slice(0, 120)}`);
    // 从 DB 读服务端 questions_json 构造权威全对答案
    const db = new Database(DB_PATHS.A); db.pragma('busy_timeout = 5000');
    const row = db.prepare('SELECT questions_json FROM exam_sessions WHERE id = ?').get(start.data.sessionId);
    db.close();
    const questions = JSON.parse(row.questions_json);
    const answers = buildExamAllCorrect(questions);
    const sub = await jA('POST', '/exam/submit', { sessionId: start.data.sessionId, answers }, ea);
    if (sub.status !== 200) throw new Error(`submit failed: ${sub.status} ${JSON.stringify(sub.data).slice(0, 200)}`);
    if (sub.data.score !== 100) throw new Error(`score=${sub.data.score}`);
    if (!sub.data.passed) throw new Error('passed=false');
    if (sub.data.xpEarned !== 30) throw new Error(`xpEarned=${sub.data.xpEarned}`);
    if (sub.data.coinEarned !== 30) throw new Error(`coinEarned=${sub.data.coinEarned}`);
  });

  await test('及格卷错题入册：90/100 → passed 且 10 错题入册', async () => {
    const reg = await jA('POST', '/auth/register', { username: `部分${Date.now() % 100000}`, password: 'exam123456' });
    const ea = auth(reg.data.token);
    const start = await jA('POST', '/exam/start', {}, ea);
    const db = new Database(DB_PATHS.A); db.pragma('busy_timeout = 5000');
    const row = db.prepare('SELECT questions_json FROM exam_sessions WHERE id = ?').get(start.data.sessionId);
    db.close();
    const questions = JSON.parse(row.questions_json);
    const answers = buildExamAllCorrect(questions);
    // 后 10 题乱填 → 错 10 题 → 90 分 ≥ 80 passed，且错题入册
    for (let i = 90; i < 100; i++) answers[i].userAnswer = '绝不可能对的答案';
    const sub = await jA('POST', '/exam/submit', { sessionId: start.data.sessionId, answers }, ea);
    if (sub.data.score !== 90) throw new Error(`score=${sub.data.score}, expect 90`);
    if (!sub.data.passed) throw new Error('passed=false at 90');
    const due = await jA('GET', '/game/mistakes/due-count', null, ea);
    if (!(due.data.dueCount >= 10)) throw new Error(`dueCount=${due.data.dueCount}, expect >= 10`);
  });

  // ═══════════ 5. 多选 remap：会话随机选项 id 后按新 id 判对 ═══════════
  console.log('\n📋 多选 remap');
  await test('multi_select 选项 id 每会话随机，按新 id 全对判对', async () => {
    const reg = await jA('POST', '/auth/register', { username: `多选${Date.now() % 100000}`, password: 'exam123456' });
    const ea = auth(reg.data.token);
    const start = await jA('POST', '/exam/start', {}, ea);
    const db = new Database(DB_PATHS.A); db.pragma('busy_timeout = 5000');
    const row = db.prepare('SELECT questions_json FROM exam_sessions WHERE id = ?').get(start.data.sessionId);
    db.close();
    const questions = JSON.parse(row.questions_json);
    const ms = questions.filter(q => q.type === 'multi_select');
    if (ms.length === 0) throw new Error('no multi_select in session');
    // 所有 ms 选项 id 都应是 ms-xxxx 随机格式，而非固定 {A,B}
    const allIds = ms.flatMap(q => q.options.map(o => o.id));
    if (!allIds.every(id => /^ms-[0-9a-f]{8}$/.test(id)))
      throw new Error(`ms 选项 id 未重映射: ${allIds.slice(0, 4).join(',')}`);
    const answers = buildExamAllCorrect(questions);
    const sub = await jA('POST', '/exam/submit', { sessionId: start.data.sessionId, answers }, ea);
    if (sub.data.score !== 100) throw new Error(`按新 id 全对应 100, got ${sub.data.score}`);
  });

  // ═══════════ 6. C10：多选池错题卡复习重映射（封死盲猜刷币链） ═══════════
  console.log('\n📋 多选复习 remap（C10）');
  await test('ms_pool 错题卡 remap_json 逐卡随机，盲猜 ["A","B"] 判错、真实集合判对', async () => {
    const reg = await jA('POST', '/auth/register', { username: `重映射${Date.now() % 100000}`, password: 'exam123456' });
    const ea = auth(reg.data.token);
    const userId = reg.data.user?.id;
    if (!userId) throw new Error('register 响应缺 user.id');
    const start = await jA('POST', '/exam/start', {}, ea);
    const db = new Database(DB_PATHS.A); db.pragma('busy_timeout = 5000');
    const row = db.prepare('SELECT questions_json FROM exam_sessions WHERE id = ?').get(start.data.sessionId);
    db.close();
    const questions = JSON.parse(row.questions_json);
    // 非 multi_select 全对、multi_select 全错（空选）→ 10 张 ms_pool 卡入册
    const answers = questions.map((node, i) => {
      let userAnswer;
      switch (node.type) {
        case 'true_false': userAnswer = node.correct_answer ? '正确' : '错误'; break;
        case 'multiple_choice': userAnswer = node.options.find(o => o.is_correct)?.text || ''; break;
        case 'multi_select': userAnswer = JSON.stringify([]); break;
        default: userAnswer = '';
      }
      return { index: i, userAnswer };
    });
    const sub = await jA('POST', '/exam/submit', { sessionId: start.data.sessionId, answers }, ea);
    if (sub.status !== 200) throw new Error(`submit failed: ${sub.status} ${JSON.stringify(sub.data).slice(0, 200)}`);

    // 每张 ms_pool 卡都带 remap_json，且值是新随机 ms-xxxx（非固定 {A,B,C,D}）
    const db2 = new Database(DB_PATHS.A); db2.pragma('busy_timeout = 5000');
    const cards = db2.prepare(
      `SELECT * FROM mistakes WHERE user_id = ? AND lesson_id = 'exam/ms_pool'`
    ).all(userId);
    db2.close();
    if (cards.length < 10) throw new Error(`ms_pool 卡 ${cards.length}, expect >= 10`);
    for (const c of cards) {
      if (!c.remap_json) throw new Error('ms_pool 卡缺 remap_json');
      const remap = JSON.parse(c.remap_json);
      const vals = Object.values(remap);
      if (!vals.every(v => /^ms-[0-9a-f]{8}$/.test(v))) throw new Error(`remap 值非随机: ${JSON.stringify(remap)}`);
      if (vals.length < 4 || new Set(vals).size !== vals.length) throw new Error('remap 未覆盖全部选项或值重复');
    }

    // GET /mistakes：卡上 options id 已重映射（绝不含固定 {A,B,C,D}）
    const queue = (await jA('GET', '/game/mistakes?limit=30', null, ea)).data.mistakes;
    const msCards = queue.filter(m => m.original_node?.type === 'multi_select');
    if (msCards.length === 0) throw new Error('queue 无 ms_pool 卡');
    const ids = msCards.flatMap(m => m.original_node.options.map(o => o.id));
    if (ids.some(id => ['A', 'B', 'C', 'D'].includes(id))) throw new Error(`卡选项 id 仍是固定 {A,B,C,D}: ${ids.slice(0, 6)}`);
    if (!ids.every(id => /^ms-[0-9a-f]{8}$/.test(id))) throw new Error(`卡选项 id 非 ms-xxxx: ${ids.slice(0, 6)}`);

    // 盲猜池的固定正确项 {A,B} → 必须判错（这就是 C10 封死的路）
    const first = msCards[0];
    const blind = await jA('POST', '/game/mistakes/review', { mistakeId: first.id, userAnswer: JSON.stringify(['A', 'B']) }, ea);
    if (blind.data.correct !== false) throw new Error(`盲猜 ["A","B"] 判对了：${JSON.stringify(blind.data)}`);

    // 用该卡 remap 后的真实正确 id 集合 → 判对（正常复习路径仍可获 credit）
    const db3 = new Database(DB_PATHS.A); db3.pragma('busy_timeout = 5000');
    const remapRow = db3.prepare('SELECT remap_json FROM mistakes WHERE id = ?').get(first.id);
    db3.close();
    const remap = JSON.parse(remapRow.remap_json);
    // 池文件正确项恒 {A,B} → remap 后正确集合 = [remap.A, remap.B]
    const real = await jA('POST', '/game/mistakes/review', { mistakeId: first.id, userAnswer: JSON.stringify([remap.A, remap.B]) }, ea);
    if (real.data.correct !== true) throw new Error(`remap 正确集合判错：${JSON.stringify(real.data)}`);
  });

  await test('旧 ms_pool 卡（无 remap_json）首次复习时兜底生成并落库', async () => {
    // 直接 INSERT 一张无 remap_json 的 ms_pool 卡（模拟 pre-C10 存量数据），
    // 复习接口应给它生成 remap_json 且判分不再认固定 {A,B,C,D}。
    const reg = await jA('POST', '/auth/register', { username: `旧卡${Date.now() % 100000}`, password: 'exam123456' });
    const ea = auth(reg.data.token);
    const userId = reg.data.user?.id;
    const db = new Database(DB_PATHS.A); db.pragma('busy_timeout = 5000');
    const pool = JSON.parse(req('fs').readFileSync(path.join(import.meta.dirname, 'backend', 'data', 'exam', 'multi_select.json'), 'utf8'));
    const pn = pool.find(n => n.type === 'multi_select' && Array.isArray(n.options));
    if (!pn) throw new Error('池中无 multi_select 节点');
    const ins = db.prepare(
      `INSERT INTO mistakes (user_id, lesson_id, node_id, node_index, question_text, user_answer, correct_answer, remap_json, next_review_date, easiness, interval_days, review_count, mastered)
       VALUES (?, 'exam/ms_pool', ?, 0, ?, '["A"]', '["A","B"]', NULL, date('now','+8 hours'), 2.5, 0, 0, 0)`
    ).run(userId, pn.id, pn.question || '');
    db.close();
    const mistakeId = ins.lastInsertRowid;
    // 复习提交固定 {A,B} → 必须判错（兜底 remap 生效）
    const blind = await jA('POST', '/game/mistakes/review', { mistakeId: mistakeId, userAnswer: JSON.stringify(['A', 'B']) }, ea);
    if (blind.data.correct !== false) throw new Error(`旧卡盲猜 ["A","B"] 判对：${JSON.stringify(blind.data)}`);
    const db2 = new Database(DB_PATHS.A); db2.pragma('busy_timeout = 5000');
    const updated = db2.prepare('SELECT remap_json FROM mistakes WHERE id = ?').get(mistakeId);
    db2.close();
    if (!updated?.remap_json) throw new Error('旧卡复习后未兜底生成 remap_json');
  });

  // ═══════════ 7. C10：错题卡 5 类题型答案键剥离 ═══════════
  console.log('\n📋 错题卡 5 类答案键剥离（C10）');
  await test('match/drag_drop/simulation_dial/simulation_probe/multimeter 卡答案键全部剥离', async () => {
    const reg = await jA('POST', '/auth/register', { username: `题型${Date.now() % 100000}`, password: 'sec123456' });
    const ea = auth(reg.data.token);
    // 三节课分别制造目标题型错题卡（l1_intro 同卡含 match+drag_drop）
    await completeWithTypesWrong(ea, 'electrician_basics', 'u1_meter_basics', 'l1_intro', ['match', 'drag_drop']);
    await completeWithTypesWrong(ea, 'electrician_basics', 'u1_meter_basics', 'l2_battery', ['simulation_dial', 'simulation_probe']);
    await completeWithTypesWrong(ea, 'electrician_basics', 'u5_multimeter_advanced', 'l1_real_panel', ['multimeter_challenge']);

    const queue = (await jA('GET', '/game/mistakes?limit=30', null, ea)).data.mistakes;
    const byType = {};
    for (const m of queue) {
      const t = m.original_node?.type;
      if (t) byType[t] = m;
    }
    if (byType.match) {
      if (byType.match.original_node.pairs) throw new Error('match 卡泄漏 pairs');
    } else throw new Error('缺 match 卡');
    if (byType.drag_drop) {
      if (byType.drag_drop.original_node.target_zone) throw new Error('drag_drop 卡泄漏 target_zone');
      if (byType.drag_drop.original_node.distractors) throw new Error('drag_drop 卡泄漏 distractors 候选');
    } else throw new Error('缺 drag_drop 卡');
    if (byType.simulation_dial) {
      const dopt = byType.simulation_dial.original_node.dial_options || [];
      if (dopt.some(o => o.is_correct !== undefined || o.is_wrong !== undefined)) throw new Error('simulation_dial 卡泄漏 is_correct/is_wrong');
      if (dopt.length === 0) throw new Error('simulation_dial 卡应保留档位标签供凭知识选择');
    } else throw new Error('缺 simulation_dial 卡');
    if (byType.simulation_probe) {
      if (byType.simulation_probe.original_node.correct_probes) throw new Error('simulation_probe 卡泄漏 correct_probes');
    } else throw new Error('缺 simulation_probe 卡');
    if (byType.multimeter_challenge) {
      const o = byType.multimeter_challenge.original_node;
      if (o.correct_setup) throw new Error('multimeter_challenge 卡泄漏 correct_setup');
      if (o.correct_display) throw new Error('multimeter_challenge 卡泄漏 correct_display');
      if (!o.target) throw new Error('multimeter_challenge 卡应保留 target 供实操渲染');
    } else throw new Error('缺 multimeter_challenge 卡');
  });

  // ═══════════ 8. UNIT：rate_limit 桶重置 / clearBucket / simulation_danger 负例 ═══════════
  console.log('\n📋 单元：rate_limit 桶 + grading 负例');
  // rate_limit 在 429 时先 res.set('Retry-After') 再 status().json()，mock 须链式提供三者。
  const mkRes = (onBlocked) => ({
    set() { return this; },
    status() { return this; },
    json() { onBlocked(); },
  });

  await test('rate_limit 过期桶自动重置（固定窗口）', async () => {
    const { rateLimit } = req('./backend/middleware/rate_limit.js');
    const limiter = rateLimit({ windowMs: 300, max: 1, scope: 'unit-window' });
    const callPass = () => new Promise(r => limiter({ ip: '9.9.9.9' }, mkRes(() => r(false)), () => r(true)));
    if (!(await callPass())) throw new Error('first call should pass');
    if (await callPass()) throw new Error('second call in window should be blocked');
    await new Promise(r => setTimeout(r, 350));
    if (!(await callPass())) throw new Error('after window expiry the bucket should reset');
  });

  await test('clearBucket 删除桶后立即放行', async () => {
    const { rateLimit, clearBucket } = req('./backend/middleware/rate_limit.js');
    const limiter = rateLimit({ windowMs: 60000, max: 1, scope: 'unit-clear' });
    const callPass = () => new Promise(r => limiter({ ip: '8.8.8.8' }, mkRes(() => r(false)), () => r(true)));
    if (!(await callPass())) throw new Error('first call should pass');
    if (await callPass()) throw new Error('should be blocked before clear');
    clearBucket('unit-clear:8.8.8.8');
    if (!(await callPass())) throw new Error('clearBucket should unblock');
  });

  await test('simulation_danger 负例：不安全操作（含子串）必须判错', async () => {
    const { gradeNode } = req('./backend/lib/grading.js');
    const node = { type: 'simulation_danger' };
    const bad = gradeNode(node, '不安全操作');
    if (bad.correct) throw new Error('不安全操作 must be wrong');
    const good = gradeNode(node, '安全操作');
    if (!good.correct) throw new Error('安全操作 must be correct');
  });

  // ─── Summary ───
  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  if (errors.length) { console.log('Failures:'); errors.forEach(e => console.log(e)); }
  serverA.kill(); serverB.kill(); serverC.kill();
  return failed === 0;
}

const servers = [];
process.on('exit', () => servers.forEach(s => { try { s.kill(); } catch {} }));
run().then(ok => process.exit(ok ? 0 : 1)).catch(e => { console.error('FATAL:', e); process.exit(1); });
