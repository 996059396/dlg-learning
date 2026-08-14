// E2E: verify post-answer visual feedback for 6 question types.
// Click intentionally WRONG answers, screenshot, inspect DOM.
//
// Findings about app behavior (gleaned from source):
//   - After answer, components show their inline feedback then onAnswer fires after 600-800ms,
//     which auto-advances to the next node. So screenshot quickly (~400ms post-click).
//   - MC / TF / FillBlank only show a blue 💡 explanation box; NO "答对/答错" wording.
//     They DO color-code option borders (red/green for MC/TF).
//   - SimulationDial / DragDrop / SimulationProbe / DangerSim show ✅/❌ banners.
//   - Sort shows "正确答案顺序：…" but no ❌.
//   - MultimeterChallenge: 确认测量 only submits if everything is right; clicking it while
//     incomplete just shows a hint. To produce a "wrong" feedback we click 跳过 (give up).

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOTS = path.join(__dirname, 'screenshots', 'answer_feedback');
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clickByText(page, text) {
  return await page.evaluate((needle) => {
    const btns = [...document.querySelectorAll('button')];
    const hit = btns.find(b => (b.textContent || '').includes(needle) && !b.disabled);
    if (hit) { hit.click(); return true; }
    return false;
  }, text);
}

async function progressHeader(page) {
  return await page.evaluate(() => {
    // 第 X / Y 题
    const m = (document.body.innerText || '').match(/第\s*(\d+)\s*\/\s*(\d+)\s*题/);
    return m ? `${m[1]}/${m[2]}` : '?';
  });
}

async function detectNodeKind(page) {
  return await page.evaluate(() => {
    if (document.querySelector('.mm-target-area, .mm-hotspot')) return 'multimeter_challenge';
    if (document.querySelector('.sort-item')) return 'sort';
    if (document.querySelector('.fill-blank-input')) return 'fill_blank';
    if (document.querySelector('.sim-hotspot')) return 'simulation_probe';
    // sim_dial buttons live inside a question-node and contain ACV/DCV/Ω/OFF labels
    const dialBtns = [...document.querySelectorAll('.question-node button')]
      .filter(b => /^(ACV|DCV|Ω|OFF|μF|Hz)/i.test((b.textContent || '').trim()));
    if (dialBtns.length >= 3) return 'simulation_dial';
    // true_false: contains both "正确" and "错误" option-btn texts. Check BEFORE MC because
    // TF buttons also have .option-letter (✓/×).
    const optionTexts = [...document.querySelectorAll('button.option-btn')]
      .map(b => (b.textContent || '').trim());
    const hasZheng = optionTexts.some(t => t.includes('正确'));
    const hasCuo   = optionTexts.some(t => t.includes('错误'));
    if (hasZheng && hasCuo && optionTexts.length === 2) return 'true_false';
    // MC: has .option-letter that is A/B/C/D
    const mcLetters = [...document.querySelectorAll('button.option-btn .option-letter')]
      .map(s => (s.textContent || '').trim());
    if (mcLetters.some(l => /^[A-Z]$/.test(l))) return 'multiple_choice';
    // match: pairs UI
    if (document.querySelector('.match-grid, .match-pair, .match-card')) return 'match';
    if (document.querySelectorAll('button.option-btn').length > 0) return 'option_based'; // drag_drop
    // info node
    const cont = [...document.querySelectorAll('button')].find(b => /继续/.test(b.textContent || ''));
    if (cont) return 'info';
    return 'unknown';
  });
}

// Advance through nodes until detectNodeKind returns a kind in `targets`.
// Answers any intervening questions correctly-as-possible to keep progressing.
async function advanceTo(page, targets, maxHops = 30) {
  for (let i = 0; i < maxHops; i++) {
    const kind = await detectNodeKind(page);
    if (targets.includes(kind)) return kind;
    if (kind === 'info') {
      await clickByText(page, '继续');
    } else if (kind === 'multiple_choice') {
      // pick the correct option (one of the buttons has is-correct via "answered correct" class? we don't know that yet)
      // Just click any option to advance.
      await page.evaluate(() => document.querySelector('button.option-btn')?.click());
    } else if (kind === 'true_false') {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button.option-btn')].find(x => (x.textContent || '').includes('正确'));
        b?.click();
      });
    } else if (kind === 'fill_blank') {
      await page.evaluate(() => {
        const inp = document.querySelector('.fill-blank-input');
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, 'x');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const c = [...document.querySelectorAll('button')].find(b => /确认答案/.test(b.textContent || ''));
        c?.click();
      });
    } else if (kind === 'simulation_dial') {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.question-node button')]
          .find(x => /DCV|ACV|Ω|OFF/i.test((x.textContent || '').trim()));
        b?.click();
      });
      await sleep(200);
      await clickByText(page, '确认档位');
    } else if (kind === 'option_based') {
      await page.evaluate(() => document.querySelector('button.option-btn')?.click());
    } else if (kind === 'simulation_probe') {
      await page.evaluate(() => {
        const hs = [...document.querySelectorAll('.sim-hotspot')];
        if (hs[0]) hs[0].click();
        if (hs[1]) hs[1].click();
      });
    } else if (kind === 'match') {
      // Match question: click random pairs to get past. Simpler: try clicking match cards in pairs.
      const advanced = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.match-card, .match-item, [class*="match"]')];
        if (cards.length >= 2 && !cards[0].disabled) {
          cards[0].click();
          if (cards[1]) cards[1].click();
          return true;
        }
        return false;
      });
      if (!advanced) {
        const skipped = await clickByText(page, '跳过');
        if (!skipped) await clickByText(page, '继续');
      }
    } else if (kind === 'multimeter_challenge') {
      await clickByText(page, '跳过');
    } else if (kind === 'sort') {
      // click items reverse-ish
      const n = await page.evaluate(() => document.querySelectorAll('.sort-item').length);
      for (let k = 0; k < n; k++) {
        await page.evaluate(() => {
          const items = document.querySelectorAll('.sort-item');
          items[items.length - 1]?.click();
        });
        await sleep(150);
      }
      await clickByText(page, '确认顺序');
    } else {
      // unknown; bail
      return kind;
    }
    await sleep(950);
  }
  return null;
}

async function inspect(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText || '';
    const phrases = ['答对了', '答错了', '正确！', '不正确', '✅', '❌', '🎉', '😞', '正确答案', '答对', '答错'];
    const present = phrases.filter(p => text.includes(p));

    const reds = [], greens = [];
    document.querySelectorAll('div, button, span').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) return;
      const cs = getComputedStyle(el);
      const parse = (s) => {
        const m = (s || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      };
      const bg = parse(cs.backgroundColor);
      const bd = parse(cs.borderColor);
      const tag = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0].slice(0, 24) : '');
      const ck = (rgb, w) => {
        if (!rgb) return;
        const [r2, g, b] = rgb;
        // Reds — strong red or very-light pink (e.g. #FFF5F5 = rgb(255,245,245))
        if (r2 >= 250 && g < 250 && b < 250 && (r2 - g) >= 5 && (r2 - b) >= 5) reds.push(tag + '@' + w);
        else if (r2 > 200 && g < 220 && b < 220 && (r2 - g) > 15 && (r2 - b) > 15) reds.push(tag + '@' + w);
        // Greens — strong green or light green (#E5F6D0, #E8F5E9)
        else if (g > 170 && (g - r2) > 5 && (g - b) > 5) greens.push(tag + '@' + w);
      };
      ck(bg, 'bg'); ck(bd, 'border');
    });
    return {
      feedbackPhrases: present,
      redElems: [...new Set(reds)].slice(0, 6),
      greenElems: [...new Set(greens)].slice(0, 6),
    };
  });
}

function report(label, info, mustHavePhrase, mustHaveColor) {
  console.log(`\n[${label}]`);
  console.log('  phrases :', info.feedbackPhrases.length ? info.feedbackPhrases.join(' | ') : '(none)');
  console.log('  reds    :', info.redElems.length ? info.redElems.join(', ') : '(none)');
  console.log('  greens  :', info.greenElems.length ? info.greenElems.join(', ') : '(none)');
  const phraseOk = info.feedbackPhrases.some(p => mustHavePhrase.includes(p));
  const colorOk  = mustHaveColor === 'red'   ? info.redElems.length   > 0
                 : mustHaveColor === 'green' ? info.greenElems.length > 0
                 : true;
  const ok = phraseOk && colorOk;
  console.log(`  ==> ${ok ? 'PASS' : 'FAIL'}  (phrase=${phraseOk}, color[${mustHaveColor}]=${colorOk})`);
  return { ok, phraseOk, colorOk, phrases: info.feedbackPhrases };
}

async function main() {
  console.log('Answer-Feedback E2E for 6 question types');
  console.log('='.repeat(60));

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 414, height: 896, isMobile: true, hasTouch: true },
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    const progress = {};
    const u1 = ['l1_intro','l2_battery','l3_safety','l4_resistance','l5_ac_voltage'];
    const u5 = ['l1_real_panel','l2_dial_selection','l3_voltage_measure','l4_current_measure','l5_resistance_capacitor','l6_repair_scenario'];
    u1.forEach(l => progress[`electrician_basics/u1_meter_basics/${l}`] = { completed: true, accuracy: 100 });
    u5.forEach(l => progress[`electrician_basics/u5_multimeter_advanced/${l}`] = { completed: true, accuracy: 100 });
    localStorage.setItem('dlg_progress', JSON.stringify(progress));
  });

  const results = {};

  // === 1. MultipleChoice (l1_intro node[3]) ===
  try {
    await page.goto('http://localhost:5173/course/electrician_basics/unit/u1_meter_basics/lesson/l1_intro', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const kind = await advanceTo(page, ['multiple_choice']);
    console.log(`\nMC: arrived at kind=${kind} (header=${await progressHeader(page)})`);
    // Click a wrong option (id A) — node[3] in l1_intro has correct=B
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button.option-btn')];
      const wrong = btns.find(b => b.querySelector('.option-letter')?.textContent?.trim() === 'A');
      if (wrong) { wrong.click(); return true; }
      // fallback: any
      btns[0]?.click(); return !!btns[0];
    });
    console.log(`MC: wrong clicked=${clicked}`);
    await sleep(450);
    await page.screenshot({ path: path.join(SHOTS, '1_mc_wrong.png'), fullPage: true });
    const info = await inspect(page);
    results.MultipleChoice = report('MultipleChoice', info,
      ['答对了', '答错了', '❌', '不正确'], 'red');
  } catch (e) {
    console.log('MC error:', e.message);
    results.MultipleChoice = { ok: false, phrases: [] };
  }

  // === 2. TrueFalse (l1_intro node[1], correct=true → click 错误) ===
  try {
    await page.goto('http://localhost:5173/course/electrician_basics/unit/u1_meter_basics/lesson/l1_intro', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const kind = await advanceTo(page, ['true_false']);
    console.log(`\nTF: arrived at kind=${kind} (header=${await progressHeader(page)})`);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button.option-btn')].find(x => (x.textContent || '').includes('错误'));
      b?.click();
    });
    await sleep(450);
    await page.screenshot({ path: path.join(SHOTS, '2_tf_wrong.png'), fullPage: true });
    const info = await inspect(page);
    results.TrueFalse = report('TrueFalse', info,
      ['答对了', '答错了', '❌', '不正确'], 'red');
  } catch (e) {
    console.log('TF error:', e.message);
    results.TrueFalse = { ok: false, phrases: [] };
  }

  // === 3. FillBlank — use l2_battery node[9] (shorter path) ===
  try {
    await page.goto('http://localhost:5173/course/electrician_basics/unit/u1_meter_basics/lesson/l2_battery', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const kind = await advanceTo(page, ['fill_blank']);
    console.log(`\nFillBlank: arrived at kind=${kind} (header=${await progressHeader(page)})`);
    if (kind === 'fill_blank') {
      await page.evaluate(() => {
        const inp = document.querySelector('.fill-blank-input');
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, 'wrongAnswer');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await clickByText(page, '确认答案');
      await sleep(450);
      await page.screenshot({ path: path.join(SHOTS, '3_fillblank_wrong.png'), fullPage: true });
      const info = await inspect(page);
      results.FillBlank = report('FillBlank', info,
        ['答对了', '答错了', '❌', '不正确'], 'red');
    } else {
      results.FillBlank = { ok: false, phrases: [], note: `arrived at ${kind}` };
    }
  } catch (e) {
    console.log('FillBlank error:', e.message);
    results.FillBlank = { ok: false, phrases: [] };
  }

  // === 4. SimulationDial (l2_battery node[3]) ===
  try {
    await page.goto('http://localhost:5173/course/electrician_basics/unit/u1_meter_basics/lesson/l2_battery', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const kind = await advanceTo(page, ['simulation_dial']);
    console.log(`\nSimDial: arrived at kind=${kind} (header=${await progressHeader(page)})`);
    // Pick a wrong dial — anything except DCV 2V
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.question-node button')]
        .filter(b => /ACV|DCV|Ω|OFF|μF|Hz/i.test((b.textContent || '').trim()));
      // wrong = anything not containing "2V" and not OFF
      const wrong = btns.find(b => /ACV.*750|DCV.*200mV|DCV.*20V|Ω/.test((b.textContent || '').trim()));
      if (wrong) { wrong.click(); return wrong.textContent.trim(); }
      return null;
    });
    console.log(`SimDial: wrong clicked = ${clicked}`);
    await sleep(300);
    await clickByText(page, '确认档位');
    await sleep(450);
    await page.screenshot({ path: path.join(SHOTS, '4_simdial_wrong.png'), fullPage: true });
    const info = await inspect(page);
    results.SimulationDial = report('SimulationDial', info,
      ['❌', '不正确', '答错了'], 'red');
  } catch (e) {
    console.log('SimDial error:', e.message);
    results.SimulationDial = { ok: false, phrases: [] };
  }

  // === 5. MultimeterChallenge (u5/l2_dial_selection node[6]) ===
  // Submit-with-no-action just shows a hint, so to produce a WRONG feedback we hit 跳过.
  try {
    await page.goto('http://localhost:5173/course/electrician_basics/unit/u5_multimeter_advanced/lesson/l2_dial_selection', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const kind = await advanceTo(page, ['multimeter_challenge']);
    console.log(`\nMM: arrived at kind=${kind} (header=${await progressHeader(page)})`);
    if (kind === 'multimeter_challenge') {
      await page.screenshot({ path: path.join(SHOTS, '5_mm_before.png'), fullPage: true });
      // Try 确认测量 first to see if it gives an error feedback (it doesn't — just hint)
      // So just press 跳过 — handleGiveUp marks resultCorrect=false
      const skipped = await clickByText(page, '跳过');
      console.log(`MM: 跳过 clicked=${skipped}`);
      await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, '5_mm_wrong.png'), fullPage: true });
      const info = await inspect(page);
      results.MultimeterChallenge = report('MultimeterChallenge', info,
        ['❌', '不正确', '答错了'], 'red');
    } else {
      results.MultimeterChallenge = { ok: false, phrases: [], note: `arrived at ${kind}` };
    }
  } catch (e) {
    console.log('MM error:', e.message);
    results.MultimeterChallenge = { ok: false, phrases: [] };
  }

  // === 6. Sort (l2_battery node[12]) ===
  try {
    await page.goto('http://localhost:5173/course/electrician_basics/unit/u1_meter_basics/lesson/l2_battery', { waitUntil: 'networkidle2' });
    await sleep(1500);
    const kind = await advanceTo(page, ['sort']);
    console.log(`\nSort: arrived at kind=${kind} (header=${await progressHeader(page)})`);
    if (kind === 'sort') {
      // Place items reversed: click items from the bottom of the available list
      const total = await page.evaluate(() => document.querySelectorAll('.sort-item').length);
      console.log(`Sort: ${total} items`);
      for (let i = 0; i < total; i++) {
        await page.evaluate(() => {
          const items = document.querySelectorAll('.sort-item');
          // Click the LAST item in the available section repeatedly
          if (items.length) items[items.length - 1].click();
        });
        await sleep(250);
      }
      await sleep(300);
      await clickByText(page, '确认顺序');
      await sleep(450);
      await page.screenshot({ path: path.join(SHOTS, '6_sort_wrong.png'), fullPage: true });
      const info = await inspect(page);
      results.Sort = report('Sort', info,
        ['答错了', '❌', '正确答案'], 'red');
    } else {
      results.Sort = { ok: false, phrases: [], note: `arrived at ${kind}` };
    }
  } catch (e) {
    console.log('Sort error:', e.message);
    results.Sort = { ok: false, phrases: [] };
  }

  await browser.close();

  console.log('\n' + '='.repeat(60));
  console.log('FINAL SUMMARY — Does each type show CLEAR 答对/答错 feedback?');
  console.log('='.repeat(60));
  for (const [k, v] of Object.entries(results)) {
    const phrases = (v.phrases || []).join(',') || '(no feedback phrases)';
    console.log(`  ${v.ok ? '[ OK ]' : '[FAIL]'}  ${k.padEnd(22)}  → ${phrases}`);
  }
  console.log(`\nScreenshots: ${SHOTS}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
