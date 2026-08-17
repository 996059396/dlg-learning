#!/usr/bin/env node
// SM-2 黄金值单元测试（compare60 C03）：直接驱动 database.js 导出的 _sm2 纯函数，
// 用固定评分序列断言精确 (easiness, interval, repetition) 值（q=4 梯子 1→6→EF、
// q<3 重置但 EF 不动、EF 下限 1.3、mastered 阈值 21）；并仿 ts-fsrs 的 rollback
// 往返不变式验证 reviewMistake 事务原子性（review_log 写入失败 ⇒ 状态 UPDATE 回滚）。
// 纯单测：不起服务器，DLG_DB_PATH 指向临时隔离库，不碰真实 app.db。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`[fatal] DLG tests require Node >= 22; got Node ${process.version}. Use a Node 24 binary.`);
  process.exit(1);
}

const req = createRequire(import.meta.url);
process.env.DLG_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'dlg-sm2-')), 'test.db');

const dbmod = req(path.join(import.meta.dirname, 'backend', 'models', 'database.js'));
const { db, initializeDatabase, _sm2, _addDays, addMistake, computeRetrievability,
  getUnreviewedMistakes, SM2_MASTERED_INTERVAL, LEECH_THRESHOLD,
  DAILY_REVIEW_CAP, DAILY_NEW_CAP, reviewMistake, todayShanghai } = dbmod;
initializeDatabase();

let passed = 0, failed = 0;
const errors = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; const m = `  ❌ ${label}: expected ${e}, got ${a}`; console.log(m); errors.push(m); }
}

// 纯 DB 层造数：一个用户 + 一张错题卡。
function seedMistake(over = {}) {
  const uid = 'u_' + Math.random().toString(36).slice(2, 10);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(uid, uid, null);
  const info = db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text)
    VALUES (?, ?, ?, ?, ?)`).run(uid, over.lesson_id || 'u1_meter_basics/l1_what_is_multimeter', 0, over.node_id || 'n1', '测试题干');
  return { uid, mistakeId: info.lastInsertRowid };
}

console.log('— _sm2 黄金值（SM-2 标准序列）—');
let s = _sm2(2.5, 0, 0, 4);
eq(s, { easiness: 2.5, interval: 1, repetition: 1 }, 'q4 r1: interval=1, EF=2.5');
s = _sm2(2.5, 1, 1, 4);
eq(s, { easiness: 2.5, interval: 6, repetition: 2 }, 'q4 r2: interval=6, EF=2.5');
s = _sm2(2.5, 6, 2, 4);
eq(s, { easiness: 2.5, interval: 15, repetition: 3 }, 'q4 r3: interval=round(6*2.5)=15, EF=2.5');
s = _sm2(2.5, 15, 3, 4);
eq(s, { easiness: 2.5, interval: 38, repetition: 4 }, 'q4 r4: interval=round(15*2.5)=38, EF=2.5');
eq(_sm2(2.5, 38, 4, 2), { easiness: 2.5, interval: 1, repetition: 0 }, 'q2 失败重置梯子，EF 不动');
eq(_sm2(2.5, 38, 4, 0), { easiness: 2.5, interval: 1, repetition: 0 }, 'q0 失败同样重置');
eq(_sm2(2.5, 6, 2, 5), { easiness: 2.6, interval: 16, repetition: 3 }, 'q5 easy: EF=2.5+0.1=2.6, I(n)=round(6*2.6)=16');
eq(_sm2(2.5, 6, 2, 3), { easiness: 2.36, interval: 14, repetition: 3 }, 'q3 hard: EF=2.5-0.14=2.36, I(n)=round(6*2.36)=14');
s = _sm2(1.3, 6, 2, 3);
eq(s.easiness, 1.3, 'EF 下限 1.3：1.3-0.14=1.16 被 clamp 回 1.3');
eq(s.interval, 8, 'clamp 后 interval=round(6*1.3)=8');
eq(SM2_MASTERED_INTERVAL, 21, 'SM2_MASTERED_INTERVAL=21');
eq(LEECH_THRESHOLD, 8, 'LEECH_THRESHOLD=8');

console.log('— reviewMistake 往返不变式（round-trip）—');
{
  const { uid, mistakeId } = seedMistake();
  let row = reviewMistake(mistakeId, uid, true, true, {});
  eq([row.easiness, row.interval_days, row.review_count], [2.5, 1, 1], 'q4 r1 落库 easiness=2.5/interval=1/count=1');
  row = reviewMistake(mistakeId, uid, true, true, {});
  eq([row.interval_days, row.review_count], [6, 2], 'q4 r2 落库 interval=6');
  row = reviewMistake(mistakeId, uid, true, true, {});
  eq([row.interval_days, row.review_count], [15, 3], 'q4 r3 落库 interval=round(6*2.5)=15');
  row = reviewMistake(mistakeId, uid, true, true, {});
  eq([row.interval_days, row.review_count, row.mastered], [38, 4, 1], 'q4 r4 interval=38 ≥21 → mastered=1');
  const log = db.prepare('SELECT quality, ease_after, interval_after FROM review_log WHERE mistake_id=? ORDER BY id ASC').all(mistakeId);
  eq(log.map(l => l.quality), [4, 4, 4, 4], 'review_log quality 序列 4,4,4,4（默认 good）');
  eq(log[3].ease_after, 2.5, 'review_log ease_after=2.5');
  row = reviewMistake(mistakeId, uid, false, false, {});
  eq([row.interval_days, row.review_count, row.mastered, row.lapses], [1, 0, 0, 1], '失败重置梯子 + lapses=1');
  row = reviewMistake(mistakeId, uid, true, true, {});
  eq([row.lapses, row.leech], [0, 0], '判对清 lapses/leech');
  row = reviewMistake(mistakeId, uid, true, true, { grade: 'easy' });
  eq([row.easiness, row.interval_days], [2.6, 6], 'grade=easy → q5 → easiness 2.5→2.6, interval=6');
}

console.log('— reviewMistake 事务原子性（rollback 往返不变式）—');
{
  const { uid, mistakeId } = seedMistake();
  const realPrepare = db.prepare.bind(db);
  let shouldFail = false;
  db.prepare = (sql) => {
    if (shouldFail && String(sql).includes('INSERT INTO review_log')) throw new Error('simulated review_log failure');
    return realPrepare(sql);
  };
  let threw = false;
  try { shouldFail = true; reviewMistake(mistakeId, uid, true, true, {}); } catch (e) { threw = true; }
  db.prepare = realPrepare; // 恢复原样
  eq(threw, true, '日志写入失败时 reviewMistake 抛出');
  const row = db.prepare('SELECT * FROM mistakes WHERE id=?').get(mistakeId);
  eq([row.easiness, row.interval_days, row.review_count, row.reviewed, row.mastered], [2.5, 0, 0, 0, 0], '状态 UPDATE 已回滚（卡未推进）');
  const logN = db.prepare('SELECT COUNT(*) c FROM review_log WHERE mistake_id=?').get(mistakeId).c;
  eq(logN, 0, 'review_log 无残留行');
}

console.log('— computeRetrievability（可提取率代理）—');
{
  const today = '2026-08-17';
  eq(computeRetrievability({ interval_days: 1, next_review_date: '2026-08-16' }, today), 0.9, 'overdue1/interval1 → R=0.9');
  const r10 = computeRetrievability({ interval_days: 10, next_review_date: '2026-08-16' }, today);
  eq(Math.abs(r10 - Math.pow(0.9, 0.1)) < 1e-9, true, `overdue1/interval10 → R=0.9^0.1≈${r10.toFixed(4)}`);
  eq(computeRetrievability({ interval_days: 0, next_review_date: '2026-08-16' }, today), null, 'interval=0（新卡）→ null');
  eq(computeRetrievability({ interval_days: 5, next_review_date: null }, today), null, '无 next_review_date → null');
  eq(computeRetrievability({ interval_days: 5, next_review_date: '2026-08-20' }, today), 1, '未到期（负 overdue clamp 0）→ R=1');
}

console.log('— getUnreviewedMistakes 按遗忘风险重排 —');
{
  const uid = 'u_ord_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(uid, uid, null);
  // 两卡同逾期（5 天）：A interval=1 → R≈0.59，B interval=20 → R≈0.974，A 更可能忘
  db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text, interval_days, review_count, next_review_date)
    VALUES (?,?,?,?,?,?,?,?)`).run(uid, 'u1_meter_basics/l1_what_is_multimeter', 0, 'a', 'qA', 1, 3, '2026-08-12');
  db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text, interval_days, review_count, next_review_date)
    VALUES (?,?,?,?,?,?,?,?)`).run(uid, 'u1_meter_basics/l1_what_is_multimeter', 0, 'b', 'qB', 20, 3, '2026-08-12');
  const list = getUnreviewedMistakes(uid, 10, 0);
  eq(list.length, 2, '两张到期卡都进队列');
  eq(list[0].interval_days, 1, 'R 更低（更可能忘）的卡排最前');
}

console.log('— 每日新增预算（compare60 C03/C07）—');
{
  const uid = 'u_budget_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(uid, uid, null);
  const today = todayShanghai();
  eq(DAILY_NEW_CAP, 20, 'DAILY_NEW_CAP=20（Anki new_per_day 默认值）');
  for (let i = 0; i < 20; i++) addMistake(uid, 'u1_meter_basics/l1_what_is_multimeter', `b_${i}`, i, `q${i}`, 'x', 'y');
  const todayCount = db.prepare(
    'SELECT COUNT(*) c FROM mistakes WHERE user_id=? AND review_count=0 AND next_review_date=?'
  ).get(uid, today).c;
  eq(todayCount, 20, '前 20 张新卡都排今天');
  addMistake(uid, 'u1_meter_basics/l1_what_is_multimeter', 'b_20', 20, 'q20', 'x', 'y');
  const n21 = db.prepare("SELECT next_review_date FROM mistakes WHERE user_id=? AND node_id='b_20'").get(uid);
  eq(n21.next_review_date, _addDays(today, 1), '第 21 张顺延到明天（不挤爆当天）');
  for (let i = 21; i < 40; i++) addMistake(uid, 'u1_meter_basics/l1_what_is_multimeter', `b_${i}`, i, `q${i}`, 'x', 'y');
  addMistake(uid, 'u1_meter_basics/l1_what_is_multimeter', 'b_40', 40, 'q40', 'x', 'y');
  const n41 = db.prepare("SELECT next_review_date FROM mistakes WHERE user_id=? AND node_id='b_40'").get(uid);
  eq(n41.next_review_date, _addDays(today, 2), '第 41 张（明天槽位满 20）再顺延到后天');
}

console.log('— 每日复习上限 + leech 优先（compare60 C03/C07）—');
{
  const uid = 'u_cap_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(uid, uid, null);
  const today = todayShanghai();
  eq(DAILY_REVIEW_CAP, 30, 'DAILY_REVIEW_CAP=30');
  // 34 张到期复习卡（interval 1..10，逾期 5 天），1 张 leech 卡（interval=20、R≈0.974）
  for (let i = 0; i < 34; i++) {
    db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text, interval_days, review_count, next_review_date)
      VALUES (?,?,?,?,?,?,?,?)`).run(uid, 'u1_meter_basics/l1_what_is_multimeter', 0, `c_${i}`, `q${i}`, 1 + (i % 10), 1, _addDays(today, -5));
  }
  db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text, interval_days, review_count, next_review_date, leech)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(uid, 'u1_meter_basics/l1_what_is_multimeter', 0, 'c_leech', 'leechQ', 20, 1, _addDays(today, -5), 1);
  const list = getUnreviewedMistakes(uid, 100, 0);
  eq(list.length, 30, '35 张到期只服务前 DAILY_REVIEW_CAP=30 张，其余惰性顺延');
  eq(list[0].node_id, 'c_leech', 'leech 顽固错题排最前（即使其 R 最高）');
  const hasDeferred = list.some(x => x.interval_days === 1);
  eq(hasDeferred, true, '最紧迫（R 最低）的卡留在队内');
}

console.log('— mastered 定期复检（compare60 C03/C07）—');
{
  const uid = 'u_reck_' + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(uid, uid, null);
  const today = todayShanghai();
  // 105 天前最后一次复习的已掌握卡（interval=21，R=0.9^(105/21)=0.9^5≈0.59<0.6）
  db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text, interval_days, review_count, next_review_date, mastered, last_review_date)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uid, 'u1_meter_basics/l1_what_is_multimeter', 0, 'm_stale', '旧卡', 21, 4, _addDays(today, -105), 1, _addDays(today, -105));
  // 10 天前刚复习过的已掌握卡 → 不该被复检
  db.prepare(`INSERT INTO mistakes (user_id, lesson_id, node_index, node_id, question_text, interval_days, review_count, next_review_date, mastered, last_review_date)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(uid, 'u1_meter_basics/l1_what_is_multimeter', 0, 'm_fresh', '新卡', 21, 4, _addDays(today, -10), 1, _addDays(today, -10));
  const list = getUnreviewedMistakes(uid, 100, 0);
  const stale = db.prepare("SELECT mastered, next_review_date FROM mistakes WHERE user_id=? AND node_id='m_stale'").get(uid);
  eq(stale.mastered, 0, 'R<0.6 的过期已掌握卡重新激活');
  eq(stale.next_review_date, today, '复检卡今天就到期重新入队');
  const fresh = db.prepare("SELECT mastered FROM mistakes WHERE user_id=? AND node_id='m_fresh'").get(uid);
  eq(fresh.mastered, 1, '最近复习过的已掌握卡保持 mastered');
  eq(list.some(x => x.node_id === 'm_stale'), true, '复检卡出现在复习队列里');
}

console.log(`\nSM-2 黄金值单测：${passed} 通过 / ${failed} 失败`);
if (failed > 0) { console.error(errors.join('\n')); process.exit(1); }
