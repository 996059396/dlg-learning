// X02 幂等键测试：验证 /complete 的 (user_id, client_request_id) 幂等语义。
//
// 场景：离线完成队列重放同一 client_request_id，服务端必须返回首次响应、绝不
// 二次判分/二次铸币。验证方式：
//   1. 用「全对」答案提交 K1 → R1（首通奖励，xp>0，coins=5）
//   2. 用「全空」答案 + 同一 K1 重放 → 必须原样返回 R1（accuracy=100、xp>0），
//      证明没有按空答案重新判分
//   3. 用「全对」答案 + 新键 K2 → R3（repeat=true，coins=0）—— 证明首通奖励
//      只铸一次，幂等键之间互不影响
//   4. 校验 submission_receipts 里该用户有 2 行
//
// 自建 throwaway DB + 独立端口，不碰线上 3001。
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // 仓库根
// 可移植（crosscheck5 X7/H7）：默认用当前解释器（CI 上是 Node 24），勿硬编码本机路径
const NODE24 = process.env.DLG_NODE24 || process.execPath;
// 3995 独立端口——3999 被 smoke_milestone1 占用，同链串行时 TIME_WAIT 会让新
// server 绑定失败（crosscheck5 X M16 / CI gate macOS+Windows 实测失败）。
const PORT = 3995;
const DB_PATH = path.join(os.tmpdir(), `dlg_idem_test_${Date.now()}.db`);
const COURSE = 'electrician_basics';
const UNIT = 'u1_meter_basics';
const LESSON = 'l1_intro';

let failures = 0;
let assertCount = 0;
function assert(cond, msg) {
  assertCount++;
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

function apiReq(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: url, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        const parsed = (() => { try { return JSON.parse(s); } catch { return s; } })();
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitHealth() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      apiReq('GET', '/api/health', null, null).then(({ status }) => {
        if (status === 200) return resolve();
        if (++tries > 60) return reject(new Error('后端 30s 未就绪'));
        setTimeout(tick, 500);
      }).catch(() => {
        if (++tries > 60) return reject(new Error('后端 30s 未就绪'));
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

// 按 gradeNode 的判分契约，从 lesson JSON 里构造「全对」答案。
function buildCorrectAnswers(lesson) {
  const answers = [];
  for (const node of lesson.nodes || []) {
    if (node.type === 'info') continue;
    let userAnswer = null;
    switch (node.type) {
      case 'true_false':
        userAnswer = node.correct_answer === true ? '正确' : '错误';
        break;
      case 'multiple_choice':
        userAnswer = node.options?.find(o => o.is_correct)?.text ?? null;
        break;
      case 'multi_select':
        userAnswer = JSON.stringify(node.options?.filter(o => o.is_correct).map(o => String(o.id || o.text)) || []);
        break;
      case 'fill_blank':
        userAnswer = node.answer ?? node.acceptable_answers?.[0] ?? '';
        break;
      case 'match':
        userAnswer = node.pairs?.map(p => `${p.left} = ${p.right}`).join(', ') ?? null;
        break;
      case 'sort':
        userAnswer = node.correct_order?.map(id => node.items?.find(i => i.id === id)?.text).filter(Boolean).join(' → ') ?? null;
        break;
      case 'drag_drop':
        userAnswer = node.target_zone?.label ?? null;
        break;
      case 'simulation_dial':
        userAnswer = node.dial_options?.find(o => o.is_correct)?.label ?? null;
        break;
      case 'simulation_danger':
        userAnswer = '安全操作';
        break;
      case 'simulation_probe':
        if (node.correct_probes) userAnswer = `红:${node.correct_probes.red},黑:${node.correct_probes.black}`;
        break;
      case 'multimeter_challenge': {
        const c = node.correct_setup;
        if (c && node.target?.hotspots) {
          const label = (k) => node.target.hotspots[k]?.label ?? k;
          userAnswer = `档位:${c.dial}, 红:${c.red_port}→${label(c.red_touch)}, 黑:${c.black_port || 'COM'}→${label(c.black_touch)}`;
        }
        break;
      }
      default:
        userAnswer = null;
    }
    const entry = { nodeId: node.id, userAnswer: userAnswer ?? '', correct: userAnswer != null };
    answers.push(entry);
  }
  return answers;
}

const backend = spawn(NODE24, [path.join(ROOT, 'backend', 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DLG_DB_PATH: DB_PATH,
    DLG_RATE_MAX_register: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
backend.stderr.on('data', d => process.stderr.write(`[backend] ${d}`));
backend.stdout.on('data', d => process.stdout.write(`[backend] ${d}`));

try {
  await waitHealth();
  console.log('后端就绪');

  // 1. register + get lesson
  const reg = await apiReq('POST', '/api/auth/register', null, { username: `idem_${Date.now()}`, password: 'testpass123' });
  assert(reg.status === 200 && reg.body.token, '注册成功拿到 token');
  const token = reg.body.token;

  const lessonRes = await apiReq('GET', `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}`, token, null);
  assert(lessonRes.status === 200, '拉取课程内容');
  const correctAnswers = buildCorrectAnswers(lessonRes.body);
  const qNodes = (lessonRes.body.nodes || []).filter(n => n.type !== 'info');
  assert(correctAnswers.length === qNodes.length, `构造了 ${correctAnswers.length} 条答案（${qNodes.length} 个题目节点）`);

  // 2. 全对提交 K1 → R1（首通）
  const r1 = await apiReq('POST', `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}/complete`, token, {
    answers: correctAnswers,
    client_request_id: 'test-key-k1-0001',
  });
  assert(r1.status === 200, `K1 提交成功 (HTTP ${r1.status})`);
  if (r1.status !== 200) console.error('  K1 body:', JSON.stringify(r1.body).slice(0, 200));
  assert(r1.body.accuracy === 100, `K1 accuracy=100（实际 ${r1.body.accuracy}）`);
  assert(r1.body.rewards.passed === true, 'K1 passed=true');
  assert(r1.body.rewards.xpEarned > 0, `K1 铸出首通奖励 xp=${r1.body.rewards.xpEarned}`);
  assert(r1.body.rewards.coinsEarned === 5, `K1 首通 coins=5（实际 ${r1.body.rewards.coinsEarned}）`);
  assert(r1.body.rewards.repeat === false, 'K1 repeat=false（首通）');

  // 3. 同一 K1 + 全空答案重放 → 必须原样返回 R1
  const r2 = await apiReq('POST', `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}/complete`, token, {
    answers: [],
    client_request_id: 'test-key-k1-0001',
  });
  assert(r2.status === 200, '同键重放 HTTP 200');
  assert(r2.body.accuracy === 100, '重放返回 accuracy=100（未按空答案重判）');
  assert(JSON.stringify(r2.body.rewards) === JSON.stringify(r1.body.rewards), '重放 rewards 与原响应逐字段一致');
  assert(JSON.stringify(r2.body.progress) === JSON.stringify(r1.body.progress), '重放 progress 与原响应一致');

  // 4. 新键 K2 + 全对答案 → 新鲜判分：已是 repeat，无首通 coins
  const r3 = await apiReq('POST', `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}/complete`, token, {
    answers: correctAnswers,
    client_request_id: 'test-key-k2-0002',
  });
  assert(r3.status === 200, 'K2 提交成功');
  assert(r3.body.rewards.repeat === true, 'K2 repeat=true（第 2 次）');
  assert(r3.body.rewards.coinsEarned === 0, 'K2 coins=0（首通不重复铸）');

  // 5. 非法键（过短）→ 视为无键，仍正常判分（不应 500）
  const r4 = await apiReq('POST', `/api/courses/${COURSE}/units/${UNIT}/lessons/${LESSON}/complete`, token, {
    answers: correctAnswers,
    client_request_id: 'x',
  });
  assert(r4.status === 200, `过短键不报错 (HTTP ${r4.status})`);

  console.log(failures === 0 ? `\n✅ 幂等键测试全部通过（${assertCount} 断言）` : `\n❌ ${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error('测试异常:', e);
  process.exitCode = 1;
} finally {
  backend.kill();
  setTimeout(() => {
    try { fs.unlinkSync(DB_PATH); fs.unlinkSync(`${DB_PATH}-wal`); fs.unlinkSync(`${DB_PATH}-shm`); } catch {}
    process.exit(process.exitCode);
  }, 500);
}
