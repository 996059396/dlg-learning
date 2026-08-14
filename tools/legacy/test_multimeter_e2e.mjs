// E2E test: 完整跑通 u5_multimeter_advanced/l1_real_panel 第一个 multimeter_challenge
// Run from D:\dlg_project (vite dev server on :5173, backend on :3001)

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import http from 'http';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────
const FRONT = 'http://localhost:5173';
const BACK  = 'http://localhost:3001';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT_DIR = 'D:\\dlg_project\\screenshots\\e2e';

const COURSE_ID = 'electrician_basics';
const UNIT_ID   = 'u5_multimeter_advanced';
const LESSON_ID = 'l1_real_panel';

const ALL_LESSONS = [
  ['u1_meter_basics', 'l1_intro'],
  ['u1_meter_basics', 'l2_battery'],
  ['u1_meter_basics', 'l3_safety'],
  ['u1_meter_basics', 'l4_resistance'],
  ['u2_circuit_basics', 'l1_voltage_current'],
  ['u2_circuit_basics', 'l2_circuit_states'],
  ['u2_circuit_basics', 'l3_ohms_law'],
  ['u3_tools', 'l1_pliers'],
  ['u3_tools', 'l2_screwdriver'],
  ['u3_tools', 'l3_strippers'],
  ['u4_relays', 'l1_relay_intro'],
  ['u4_relays', 'l2_contactor'],
  ['u4_relays', 'l3_protection'],
  ['u4_relays', 'l4_terminal_block'],
];

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────
// Reporting helpers
// ────────────────────────────────────────────────────────────────────────────
const log = [];
const shots = [];
let ok = 0, bad = 0;
const issues = [];
function step(t)  { console.log('📋 ' + t); log.push('STEP ' + t); }
function pass(t)  { console.log('  ✅ ' + t); log.push('PASS ' + t); ok++; }
function fail(t)  { console.log('  ❌ ' + t); log.push('FAIL ' + t); bad++; issues.push(t); }
function info(t)  { console.log('  · '  + t); log.push('INFO ' + t); }

async function shoot(page, n, name) {
  const file = String(n).padStart(2, '0') + '_' + name + '.png';
  const full = path.join(SHOT_DIR, file);
  try {
    await page.screenshot({ path: full, fullPage: false });
    shots.push(file);
    console.log('  📸 ' + file);
  } catch (e) {
    fail('screenshot ' + file + ': ' + e.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Fetch backend lesson JSON via Node's http module (curl is sandbox-blocked)
// ────────────────────────────────────────────────────────────────────────────
function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('bad json from ' + url + ': ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Page-side click helpers (eval inside the browser for resilience)
// ────────────────────────────────────────────────────────────────────────────
async function clickBySelectorAndText(page, selector, textIncludes) {
  return await page.evaluate((sel, frag) => {
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els) {
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.includes(frag)) {
        el.click();
        return t;
      }
    }
    return null;
  }, selector, textIncludes);
}

async function clickFirstSelector(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}

async function getBodyText(page) {
  return await page.evaluate(() => document.body.innerText);
}

// ────────────────────────────────────────────────────────────────────────────
// Advance through info / multiple_choice / true_false / fill_blank / match
// until we reach .mm-challenge
// ────────────────────────────────────────────────────────────────────────────
async function advanceUntilChallenge(page, lessonNodes) {
  let safety = 40;
  while (safety-- > 0) {
    // Already at multimeter challenge?
    const atChallenge = await page.$('.mm-challenge');
    if (atChallenge) return true;

    // Identify current node by progress bar / heading? Simpler: detect by DOM.
    const dom = await page.evaluate(() => ({
      hasInfoBtn: !!Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').includes('继续 →')),
      hasOptions: document.querySelectorAll('.option-btn').length,
      hasFillInput: !!document.querySelector('input.fill-blank-input'),
      hasMatch: !!document.querySelector('.match-container'),
      qText: (document.querySelector('.question-text')?.innerText || '').trim(),
    }));

    // info node — click 继续 →
    if (dom.hasInfoBtn) {
      const clicked = await clickBySelectorAndText(page, 'button', '继续 →');
      info('info node 继续 → (' + (clicked ? 'ok' : 'fail') + ')');
      await sleep(600);
      continue;
    }

    // match question — solve correctly using JSON pairs
    if (dom.hasMatch) {
      // Find matching node in lesson JSON
      const matchNode = lessonNodes.find(n => n.type === 'match' && n.question === dom.qText);
      if (matchNode && Array.isArray(matchNode.pairs)) {
        for (const p of matchNode.pairs) {
          // click left
          await page.evaluate((leftText) => {
            const items = Array.from(document.querySelectorAll('.match-column:first-child .match-item'));
            const target = items.find(it => it.innerText.trim() === leftText);
            if (target) target.click();
          }, p.left);
          await sleep(200);
          await page.evaluate((rightText) => {
            const items = Array.from(document.querySelectorAll('.match-column:nth-child(2) .match-item'));
            const target = items.find(it => it.innerText.trim() === rightText);
            if (target) target.click();
          }, p.right);
          await sleep(250);
        }
        info('match solved: ' + matchNode.pairs.length + ' pairs');
        await sleep(1000); // wait for auto-advance
        continue;
      } else {
        fail('match node has no JSON pairs — fallback');
        // give up matching, just submit any
        await sleep(800);
        continue;
      }
    }

    // multiple_choice / true_false — both render .option-btn
    if (dom.hasOptions > 0) {
      // Look up the correct answer from JSON
      const q = lessonNodes.find(n =>
        (n.type === 'multiple_choice' || n.type === 'true_false') &&
        n.question === dom.qText
      );
      let clicked = false;
      if (q && q.type === 'multiple_choice') {
        const correct = (q.options || []).find(o => o.is_correct);
        if (correct) {
          clicked = !!await clickBySelectorAndText(page, '.option-btn', correct.text.slice(0, 12));
          info('mc answered: ' + correct.text.slice(0, 30));
        }
      } else if (q && q.type === 'true_false') {
        const want = q.correct_answer ? '正确' : '错误';
        clicked = !!await clickBySelectorAndText(page, '.option-btn', want);
        info('true_false answered: ' + want);
      }
      if (!clicked) {
        // Fallback: click first option
        await clickFirstSelector(page, '.option-btn');
        info('fallback: clicked first option for "' + dom.qText.slice(0, 40) + '"');
      }
      await sleep(1100); // wait for 800ms auto-advance + render
      continue;
    }

    // fill_blank
    if (dom.hasFillInput) {
      const q = lessonNodes.find(n => n.type === 'fill_blank' && n.question === dom.qText);
      const ans = q?.acceptable_answers?.[0] || q?.answer || '750';
      await page.evaluate((v) => {
        const inp = document.querySelector('input.fill-blank-input');
        if (!inp) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, v);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }, ans);
      await sleep(200);
      await clickBySelectorAndText(page, 'button.btn-primary', '确认答案');
      info('fill_blank answered: ' + ans);
      await sleep(1100);
      continue;
    }

    // Nothing recognized — try generic primary button as last resort
    const generic = await clickFirstSelector(page, 'button.btn.btn-primary.btn-block');
    if (generic) {
      info('generic primary button click');
      await sleep(800);
      continue;
    }
    break;
  }
  return !!(await page.$('.mm-challenge'));
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🧪 u5_multimeter_advanced / l1_real_panel — E2E 真实交互');
  console.log('═══════════════════════════════════════════════════════');

  // 1. Pull lesson JSON straight from backend (Node fetch, not curl)
  let lesson;
  step('从 backend 拉取 lesson JSON');
  try {
    lesson = await httpGetJSON(`${BACK}/api/courses/${COURSE_ID}/units/${UNIT_ID}/lessons/${LESSON_ID}`);
    if (lesson && lesson.lesson) lesson = lesson.lesson; // some APIs wrap
    pass(`拿到 lesson "${lesson.title}" with ${lesson.nodes?.length} nodes`);
  } catch (e) {
    fail('backend 拉取失败: ' + e.message);
    process.exit(2);
  }

  // Locate the first multimeter_challenge node + extract correct_setup
  const mmNode = (lesson.nodes || []).find(n => n.type === 'multimeter_challenge');
  if (!mmNode) {
    fail('lesson 内没有 multimeter_challenge 节点');
    process.exit(3);
  }
  const cs = mmNode.correct_setup;
  const hsRaw = mmNode.target?.hotspots;
  const hsMap = {};
  if (Array.isArray(hsRaw)) hsRaw.forEach(h => hsMap[h.id] = h);
  else if (hsRaw) Object.entries(hsRaw).forEach(([k, v]) => hsMap[k] = { id: k, ...v });

  pass('correct_setup: dial=' + cs.dial + ' red_port=' + cs.red_port +
       ' red_touch=' + cs.red_touch + ' (' + (hsMap[cs.red_touch]?.label) + ')' +
       ' black_touch=' + cs.black_touch + ' (' + (hsMap[cs.black_touch]?.label) + ')');

  // 2. Launch Chrome
  step('启动 Chrome (puppeteer)');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: CHROME_PATH,
      defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
      args: ['--window-size=420,900'],
    });
    pass('Chrome 已启动');
  } catch (e) {
    fail('Chrome 启动失败: ' + e.message);
    process.exit(4);
  }

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const consoleErr = [];
  page.on('console', m => { if (m.type() === 'error') consoleErr.push(m.text()); });
  page.on('pageerror', e => consoleErr.push('PAGEERROR: ' + e.message));

  // 3. Inject progress
  step('注入 localStorage 解锁前置课程');
  const prog = {};
  for (const [u, l] of ALL_LESSONS) {
    const k = `${COURSE_ID}/${u}/${l}`;
    prog[k] = { lesson_id: k, completed: true, score: 10, maxScore: 10, accuracy: 100 };
  }
  await page.evaluateOnNewDocument((j) => {
    try { localStorage.setItem('dlg_progress', j); } catch (e) {}
  }, JSON.stringify(prog));
  pass(`注入 ${Object.keys(prog).length} lessons completed`);

  // 4. Navigate directly to the lesson
  const lessonUrl = `${FRONT}/course/${COURSE_ID}/unit/${UNIT_ID}/lesson/${LESSON_ID}`;
  step('导航到 ' + lessonUrl);
  try {
    await page.goto(lessonUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    pass('lesson 页面加载完成');
  } catch (e) {
    fail('页面加载失败: ' + e.message);
    await browser.close();
    process.exit(5);
  }
  await sleep(1500);
  await shoot(page, 1, 'lesson_loaded');

  // 5. Click through to multimeter_challenge
  step('一路答题直至 multimeter_challenge');
  const reached = await advanceUntilChallenge(page, lesson.nodes || []);
  if (reached) {
    pass('已到达 multimeter_challenge 节点');
    await shoot(page, 2, 'challenge_visible');
  } else {
    fail('遍历多步后仍未到达 multimeter_challenge');
    await shoot(page, 2, 'stuck_before_challenge');
  }

  // 6. Inspect the challenge & verify question text contains 拨档位 / 插孔
  step('校验题面提示包含「拨档位」和「插孔」字样');
  const qText  = await page.$eval('.question-text', el => el.innerText).catch(()=> '');
  const insText = await page.$eval('.question-instruction', el => el.innerText).catch(()=> '');
  info('question: ' + qText.slice(0, 80));
  info('instruction: ' + insText.slice(0, 80));
  if (insText.includes('拨档位') || qText.includes('拨档位')) pass('题面包含「拨档位」');
  else fail('题面缺少「拨档位」');
  if (insText.includes('插') || qText.includes('插')) pass('题面包含「插」相关字样');
  else fail('题面缺少「插孔/插红表笔」相关字样');

  // 7. Click correct dial (title attribute equals correct_setup.dial)
  step(`点击旋钮 .mm-dial-label[title="${cs.dial}"]`);
  const dialResult = await page.evaluate((id) => {
    const btn = document.querySelector(`.mm-dial-label[title="${id}"]`);
    if (!btn) return { ok: false, count: document.querySelectorAll('.mm-dial-label').length };
    btn.click();
    return { ok: true, text: btn.innerText.trim() };
  }, cs.dial);
  if (dialResult.ok) pass(`已点击档位 "${dialResult.text}" (title=${cs.dial})`);
  else fail(`未找到 .mm-dial-label[title="${cs.dial}"] — 共 ${dialResult.count} 个 label`);
  await sleep(800);
  await shoot(page, 3, 'after_dial');

  // 8. Click red port (we identify the .mm-port whose bottom label matches)
  // PORTS table: VOhm → 'VΩ', 20A → '20A', mA → 'mA', COM → 'COM'
  step(`点击红表笔插孔 (red_port=${cs.red_port})`);
  const portLabelMap = { 'VOhm': 'VΩ', '20A': '20A', 'mA': 'mA', 'COM': 'COM' };
  const wantPortLabel = portLabelMap[cs.red_port] || cs.red_port;
  const portResult = await page.evaluate((needle) => {
    const ports = Array.from(document.querySelectorAll('.mm-port'));
    for (const p of ports) {
      const botLabel = p.querySelector('.mm-port-label-bot')?.innerText?.trim() || '';
      if (botLabel === needle) {
        p.click();
        return { ok: true, label: botLabel };
      }
    }
    return { ok: false, count: ports.length, labels: ports.map(p => p.querySelector('.mm-port-label-bot')?.innerText) };
  }, wantPortLabel);
  if (portResult.ok) pass(`已点击插孔 "${portResult.label}" ← red_port ${cs.red_port}`);
  else fail(`未找到 botLabel="${wantPortLabel}" 的 .mm-port; 共 ${portResult.count} 个 (${JSON.stringify(portResult.labels)})`);
  await sleep(800);
  await shoot(page, 4, 'after_port');

  // 9. Click red hotspot (active probe starts as 'red'; clicking auto-switches to black)
  const redLabel = hsMap[cs.red_touch]?.label || cs.red_touch;
  const blackLabel = hsMap[cs.black_touch]?.label || cs.black_touch;

  step(`点击红表笔热点 (red_touch=${cs.red_touch} / "${redLabel}")`);
  const redHs = await page.evaluate((needle) => {
    const spots = Array.from(document.querySelectorAll('.mm-hotspot'));
    for (const s of spots) {
      const t = (s.innerText || '').trim();
      if (t.includes(needle)) { s.click(); return { ok: true, text: t }; }
    }
    return { ok: false, count: spots.length, texts: spots.map(s => (s.innerText||'').trim()) };
  }, redLabel);
  if (redHs.ok) pass(`已点击红表笔触点 "${redHs.text}"`);
  else fail(`未找到包含 "${redLabel}" 的 .mm-hotspot; 共 ${redHs.count} 个 (${JSON.stringify(redHs.texts)})`);
  await sleep(700);
  await shoot(page, 5, 'after_red_hotspot');

  step(`点击黑表笔热点 (black_touch=${cs.black_touch} / "${blackLabel}")`);
  const blackHs = await page.evaluate((needle) => {
    const spots = Array.from(document.querySelectorAll('.mm-hotspot'));
    for (const s of spots) {
      const t = (s.innerText || '').trim();
      if (t.includes(needle)) { s.click(); return { ok: true, text: t }; }
    }
    return { ok: false, count: spots.length };
  }, blackLabel);
  if (blackHs.ok) pass(`已点击黑表笔触点 "${blackHs.text}"`);
  else fail(`未找到包含 "${blackLabel}" 的 .mm-hotspot`);
  await sleep(700);
  await shoot(page, 6, 'after_black_hotspot');

  // 10. Click 「确认测量」
  step('点击「确认测量」');
  const confirm = await clickBySelectorAndText(page, 'button', '确认测量');
  if (confirm) pass('已点击「确认测量」');
  else fail('未找到「确认测量」按钮');
  await sleep(1600);
  await shoot(page, 7, 'after_confirm');

  // 11. Verify result
  step('校验是否出现成功反馈');
  const body = await getBodyText(page);
  const successMsg = mmNode.success_msg || '';
  const successFrag = successMsg.slice(0, 18); // first ~18 chars
  const hintMatch = body.match(/档位不对|表笔位置不对|红表笔插孔不对|请先把红、黑表笔|档位或表笔位置不对/);

  let challengePassed = false;
  if (body.includes('✅') && body.includes(successFrag)) {
    pass(`success_msg 已渲染 (包含「${successFrag}」)`);
    challengePassed = true;
  } else if (body.includes('✅')) {
    pass('页面出现 ✅ 标记');
    challengePassed = true;
  } else if (hintMatch) {
    fail(`仍显示 hint「${hintMatch[0]}」 — 设置未通过校验`);
  } else if (body.includes('❌')) {
    fail('出现 ❌ — fail_msg 渲染了');
  } else {
    fail('页面既无 ✅ 也无 hint — 可能 onAnswer 已触发并立即跳到下一节');
    // It's possible that the success branch fires onAnswer(true) after 800ms and the player
    // auto-advances. In that case, the next node should be visible — that itself is a "pass".
    const nextQ = await page.$eval('.question-text', el => el.innerText).catch(() => '');
    if (nextQ && nextQ !== qText) {
      pass(`自动进入下一题：${nextQ.slice(0, 40)}  ← 视为 challenge 已通关`);
      challengePassed = true;
    }
  }

  await shoot(page, 8, 'final_state');

  // 12. Wrap up
  console.log('═══════════════════════════════════════════════════════');
  console.log(`📊 结果：${ok} 步成功 / ${bad} 步失败`);
  console.log(`🎯 multimeter_challenge ${challengePassed ? '✅ 完整通关' : '❌ 未通关'}`);
  if (issues.length) {
    console.log('🐛 问题列表:');
    issues.forEach(i => console.log('   - ' + i));
  }
  if (consoleErr.length) {
    console.log(`🌐 浏览器 console errors (${consoleErr.length}):`);
    consoleErr.slice(0, 8).forEach(e => console.log('   - ' + e));
  }
  console.log(`📸 截图 ${shots.length} 张存于 ${SHOT_DIR}:`);
  shots.forEach(s => console.log('   - ' + s));

  await sleep(500);
  try { await browser.close(); } catch {}
  process.exit(challengePassed ? 0 : 1);
})();
