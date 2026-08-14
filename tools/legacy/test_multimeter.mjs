// E2E test: 万用表 (Multimeter) Challenge component
// Usage: node test_multimeter.mjs   (run from D:\dlg_project; dev server must already be running on :5173)

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────
const BASE_URL = 'http://localhost:5173';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOT_DIR = 'D:\\dlg_project\\screenshots\\multimeter';

const COURSE_ID = 'electrician_basics';
const UNIT_ID = 'u5_multimeter_advanced';
const LESSON_ID = 'l1_real_panel';

// All lesson IDs (extracted from u1‒u5 JSON) that must be marked complete
// so that u5/l1_real_panel is unlocked.
const ALL_LESSONS = [
  // u1_meter_basics — best-effort enumeration (real unit has 4 lessons)
  ['u1_meter_basics', 'l1_intro'],
  ['u1_meter_basics', 'l2_battery'],
  ['u1_meter_basics', 'l3_safety'],
  ['u1_meter_basics', 'l4_resistance'],
  // u2_circuit_basics
  ['u2_circuit_basics', 'l1_voltage_current'],
  ['u2_circuit_basics', 'l2_circuit_states'],
  ['u2_circuit_basics', 'l3_ohms_law'],
  // u3_tools
  ['u3_tools', 'l1_pliers'],
  ['u3_tools', 'l2_screwdriver'],
  ['u3_tools', 'l3_strippers'],
  // u4_relays
  ['u4_relays', 'l1_relay_intro'],
  ['u4_relays', 'l2_contactor'],
  ['u4_relays', 'l3_protection'],
  ['u4_relays', 'l4_terminal_block'],
  // u5_multimeter_advanced
  ['u5_multimeter_advanced', 'l1_real_panel'],
  ['u5_multimeter_advanced', 'l2_dial_selection'],
  ['u5_multimeter_advanced', 'l3_voltage_measure'],
  ['u5_multimeter_advanced', 'l4_current_measure'],
  ['u5_multimeter_advanced', 'l5_resistance_capacitor'],
  ['u5_multimeter_advanced', 'l6_repair_scenario'],
];

// The first multimeter_challenge inside l1_real_panel (node id l1_real_panel_n10)
// target: 220V wall outlet, hotspots: live / neutral / ground
// JSON says correct_setup: dial=ACV_750V, red_port=PORT_VOHM, black_port=PORT_COM,
//                          red_touch=live, black_touch=neutral
// — but the React MultimeterDial uses id 'ACV_750' (no V suffix) and ports are 'VOhm'/'COM'/'mA'/'20A'.
// Try the JSON values first; the dial-label match falls back to clicking by visible text.
const EXPECTED = {
  dial_id_json: 'ACV_750V',
  dial_id_react: 'ACV_750',       // what the React DEFAULT_DIAL_POSITIONS expects
  dial_label_visible: '750~',     // user-visible label on the dial knob
  red_port_json: 'PORT_VOHM',
  red_port_react: 'VOhm',         // selector via aria? actually no aria — must click .mm-port containing 'VΩ' label
  red_touch_json: 'live',
  black_touch_json: 'neutral',
  expected_display: '220.5 V',
  success_msg_substr: '家用 220V 是交流电',
};

if (!fs.existsSync(SHOT_DIR)) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
}

const errors = [];
let successCount = 0;
let failCount = 0;
const shotsTaken = [];

function logStep(line) { console.log(line); }
function logOk(line)   { console.log('  ✅ ' + line); successCount++; }
function logBug(line)  { console.log('  ❌ ' + line); failCount++; errors.push(line); }
function logShot(name) { shotsTaken.push(name); console.log('  📸 ' + name); }

async function shoot(page, n, name) {
  const file = String(n).padStart(2, '0') + '_' + name + '.png';
  const full = path.join(SHOT_DIR, file);
  try {
    await page.screenshot({ path: full, fullPage: false });
    logShot(file);
  } catch (e) {
    logBug('screenshot ' + file + ' failed: ' + e.message);
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeStep(label, fn) {
  try {
    logStep('📋 ' + label);
    await fn();
  } catch (e) {
    logBug(label + ' — exception: ' + (e && e.message ? e.message : String(e)));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🧪 万用表组件 E2E 交互测试');
  console.log('═══════════════════════════════════');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: CHROME_PATH,
      defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
      args: ['--window-size=420,900'],
    });
  } catch (e) {
    console.log('  ❌ 无法启动 Chrome: ' + e.message);
    console.log('═══════════════════════════════════');
    console.log('📊 总结: 0 步成功 / 1 步失败');
    process.exit(1);
  }

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // Forward browser console errors so we can spot React render warnings
  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  // ── Inject progress before React boots ────────────────────────────────
  await safeStep('解锁前置课程', async () => {
    const progress = {};
    for (const [u, l] of ALL_LESSONS) {
      const k = COURSE_ID + '/' + u + '/' + l;
      progress[k] = { lesson_id: k, completed: true, score: 10, maxScore: 10, accuracy: 100 };
    }
    const progressJson = JSON.stringify(progress);
    await page.evaluateOnNewDocument((p) => {
      try { localStorage.setItem('dlg_progress', p); } catch (e) {}
    }, progressJson);
    logOk('注入 localStorage 进度 (' + Object.keys(progress).length + ' lessons)');
  });

  // ── Navigate ──────────────────────────────────────────────────────────
  await safeStep('导航到首页', async () => {
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
      logOk('页面加载完成');
    } catch (e) {
      throw new Error('无法连接 ' + BASE_URL + '：' + e.message + '（请确认 vite dev server 已在 5173 端口运行）');
    }
    await sleep(1500);
    await shoot(page, 1, 'home');
  });

  // Jump directly to the lesson URL — react-router will mount LessonPlayer.
  // This is more reliable than clicking through CourseTree (which depends on
  // unit cards being unlocked and rendering, and on heart-deduction flow).
  const lessonUrl = BASE_URL + '/course/' + COURSE_ID + '/unit/' + UNIT_ID + '/lesson/' + LESSON_ID;

  await safeStep('导航到 u5_multimeter_advanced / l1_real_panel', async () => {
    await page.goto(lessonUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(1500);
    const title = await page.title();
    logOk('已打开 lesson URL（title="' + title + '"）');
    await shoot(page, 2, 'lesson_loaded');
  });

  // ── Click through info nodes until first multimeter_challenge ────────
  await safeStep('跳过 info 节点，定位 multimeter_challenge', async () => {
    let safety = 25;
    let found = false;
    while (safety-- > 0) {
      // Look for the multimeter_challenge container
      const hasChallenge = await page.$('.mm-challenge');
      if (hasChallenge) { found = true; break; }

      // Look for an InfoNode "继续 →" button or any primary button
      const buttons = await page.$$('button.btn.btn-primary.btn-block');
      // Try to find one whose text contains "继续"
      let clicked = false;
      for (const b of buttons) {
        const txt = await page.evaluate(el => el.innerText, b);
        if (txt && txt.includes('继续')) {
          await b.click();
          clicked = true;
          break;
        }
      }
      if (!clicked && buttons.length > 0) {
        // Fall back to clicking the first primary button
        try { await buttons[0].click(); clicked = true; } catch {}
      }
      if (!clicked) {
        // Maybe a non-info question (e.g. multiple_choice) is in the way — handle it
        const option = await page.$('.option-btn');
        if (option) {
          // Pick a random option (may be wrong, but we just need to advance)
          // Better: try to detect 'correct' class after click — but we don't know answer
          // Strategy: pick first option, then wait.
          await option.click();
          await sleep(900);
          clicked = true;
        }
      }
      if (!clicked) break;
      await sleep(800);
    }
    if (found) {
      logOk('找到 multimeter_challenge 容器 (.mm-challenge)');
      await shoot(page, 3, 'challenge_visible');
    } else {
      logBug('遍历 25 步后仍未到达 multimeter_challenge — 可能 info/题目结构变更或题型不被支持');
    }
  });

  // ── Inspect the challenge node ────────────────────────────────────────
  let questionText = '';
  await safeStep('读取当前题目内容', async () => {
    questionText = await page.$eval('.question-text', el => el.innerText).catch(() => '');
    if (questionText) logOk('题目: ' + questionText.slice(0, 60));
    else logBug('找不到 .question-text');
  });

  // ── Click correct dial gear ───────────────────────────────────────────
  // The JSON says dial = 'ACV_750V', React expects id 'ACV_750'.
  // Each .mm-dial-label button has title=id (e.g. title="ACV_750").
  await safeStep('点击旋钮档位 (ACV_750 / 750~)', async () => {
    // Try by title attribute first
    let clicked = false;
    const sel1 = '.mm-dial-label[title="' + EXPECTED.dial_id_react + '"]';
    let btn = await page.$(sel1);
    if (btn) {
      await btn.click();
      logOk('已点击 ' + sel1);
      clicked = true;
    } else {
      // Fallback: find by visible text matching '750~'
      const handles = await page.$$('.mm-dial-label');
      for (const h of handles) {
        const txt = await page.evaluate(el => el.innerText.trim(), h);
        if (txt === EXPECTED.dial_label_visible) {
          await h.click();
          logOk('按可见文本 "' + EXPECTED.dial_label_visible + '" 点击成功');
          clicked = true;
          break;
        }
      }
    }
    if (!clicked) {
      logBug('未找到旋钮 ACV_750 (JSON 用 "ACV_750V" 但组件用 "ACV_750"  ID 不一致 — bug)');
    }
    await sleep(700);
    await shoot(page, 4, 'dial_clicked');
  });

  // ── Click red probe port (VOhm) ──────────────────────────────────────
  // MultimeterPorts.jsx renders .mm-port — there is no data attribute.
  // We must locate by inner text 'VΩ' (the bottom label of the VOhm port).
  await safeStep('点击红表笔插孔 (VΩ)', async () => {
    const ports = await page.$$('.mm-port');
    let clicked = false;
    for (const p of ports) {
      const txt = await page.evaluate(el => el.innerText, p);
      if (txt && txt.includes('VΩ')) {
        await p.click();
        logOk('已点击 VΩ 插孔 (' + ports.length + ' 个 .mm-port 候选)');
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      logBug('未找到 VΩ 插孔 — .mm-port 数量=' + ports.length);
    }
    await sleep(700);
    await shoot(page, 5, 'port_clicked');
  });

  // ── Click red hotspot, then black hotspot ────────────────────────────
  // Challenge node uses target.hotspots — JSON has array form
  //    [{id:'live',label:'火线孔 (L)'}, {id:'neutral',...}, {id:'ground',...}]
  // but React does Object.entries(hotspots) expecting an object map. With an
  // array, Object.entries gives [["0",{...}],["1",{...}],["2",{...}]] so
  // hotspots[key] in handleHotspotClick uses numeric keys instead of 'live'.
  // We click by visible label text.
  await safeStep('点击红表笔触点 (火线孔 L)', async () => {
    const spots = await page.$$('.mm-hotspot');
    let clicked = false;
    for (const s of spots) {
      const txt = await page.evaluate(el => el.innerText, s);
      if (txt && txt.includes('火线')) {
        await s.click();
        logOk('已点击「火线孔 (L)」 (.mm-hotspot 候选=' + spots.length + ')');
        clicked = true;
        break;
      }
    }
    if (!clicked) logBug('未找到「火线」热点 — .mm-hotspot 数量=' + spots.length);
    await sleep(700);
    await shoot(page, 6, 'hotspot_red_clicked');
  });

  await safeStep('点击黑表笔触点 (零线孔 N)', async () => {
    const spots = await page.$$('.mm-hotspot');
    let clicked = false;
    for (const s of spots) {
      const txt = await page.evaluate(el => el.innerText, s);
      if (txt && txt.includes('零线')) {
        await s.click();
        logOk('已点击「零线孔 (N)」');
        clicked = true;
        break;
      }
    }
    if (!clicked) logBug('未找到「零线」热点');
    await sleep(700);
    await shoot(page, 7, 'hotspot_black_clicked');
  });

  // ── Submit ────────────────────────────────────────────────────────────
  await safeStep('点击「确认测量」提交', async () => {
    const buttons = await page.$$('button');
    let clicked = false;
    for (const b of buttons) {
      const txt = await page.evaluate(el => el.innerText, b).catch(() => '');
      if (txt && txt.includes('确认测量')) {
        await b.click();
        logOk('已点击「确认测量」');
        clicked = true;
        break;
      }
    }
    if (!clicked) logBug('未找到「确认测量」按钮');
    await sleep(1500);
    await shoot(page, 8, 'after_submit');
  });

  // ── Verify success ────────────────────────────────────────────────────
  await safeStep('校验是否显示 success_msg / expected_display', async () => {
    const bodyText = await page.evaluate(() => document.body.innerText);
    let any = false;
    if (bodyText.includes(EXPECTED.success_msg_substr)) {
      logOk('页面包含 success_msg 片段「' + EXPECTED.success_msg_substr + '」');
      any = true;
    }
    if (bodyText.includes(EXPECTED.expected_display)) {
      logOk('页面包含 expected_display「' + EXPECTED.expected_display + '」');
      any = true;
    }
    // Check for the visible hint that would indicate a wrong submission
    const hint = bodyText.match(/档位不对|表笔位置不对|红表笔插孔不对/);
    if (hint) {
      logBug('提交后出现错误提示「' + hint[0] + '」 — 设置未通过校验');
    }
    if (!any && !hint) {
      logBug('既未检测到 success_msg / expected_display，也未见 hint — 可能根本没渲染反馈区');
    }
  });

  // ── Wrap up ───────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════');
  console.log('📊 总结: ' + successCount + ' 步成功 / ' + failCount + ' 步失败');

  if (consoleErrors.length) {
    console.log('🌐 浏览器控制台错误 (' + consoleErrors.length + '):');
    for (const e of consoleErrors.slice(0, 12)) console.log('   - ' + e);
  }

  console.log('🐛 发现的问题:');
  if (errors.length === 0) {
    console.log('  （无）');
  } else {
    for (const e of errors) console.log('  - ' + e);
  }

  console.log('📸 截图共 ' + shotsTaken.length + ' 张:');
  for (const s of shotsTaken) console.log('   - ' + s);

  try { await browser.close(); } catch {}
  process.exit(failCount > 0 ? 1 : 0);
})();
