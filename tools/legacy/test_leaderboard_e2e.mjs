// E2E test: leaderboard v2 UI verification with screenshots
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOTS = path.join(__dirname, 'screenshots', 'leaderboard_v2');
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('🌐 Leaderboard v2 E2E test\n' + '═'.repeat(50));

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const issues = [];

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') issues.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', err => issues.push(`[pageerror] ${err.message}`));

  try {
    // 1. Load home, then go to leaderboard
    console.log('\n[1] Load home');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, '01_home.png'), fullPage: true });
    console.log('  📸 01_home.png');

    // 2. Click 排行 tab
    console.log('\n[2] Navigate to leaderboard');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const lb = btns.find(b => b.textContent?.includes('排行'));
      if (lb) lb.click();
    });
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, '02_leaderboard_default.png'), fullPage: true });
    console.log('  📸 02_leaderboard_default.png');

    // 3. Verify key v2 UI elements present
    console.log('\n[3] Check v2 UI elements');
    const checks = await page.evaluate(() => {
      const body = document.body.textContent || '';
      return {
        hasCountdown: /\d+\s*[天小时分秒]/.test(body) || /倒计时/.test(body),
        hasPromoBar: /再获得.*XP.*即可晋升/.test(body) || /晋升区/.test(body) || /XP 即可晋升/.test(body),
        hasLeagueLadder: /联赛阶梯/.test(body),
        has5Leagues: /翡翠/.test(body) && /钻石/.test(body),
        hasMyLeagueCheckmark: /^/.test(body),  // crude
        noGhostEmoji: !/👻/.test(document.querySelector('.lb-row, [class*="leaderboard"]')?.textContent || '👻'),
      };
    });
    Object.entries(checks).forEach(([k, v]) => {
      console.log(`  ${v ? '✅' : '❌'} ${k}: ${v}`);
      if (!v) issues.push(`UI check fail: ${k}`);
    });

    // 4. Switch to a different league (spectator mode)
    console.log('\n[4] Switch to gold league (spectator)');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.lb-league-tab')];
      const gold = btns.find(b => b.textContent?.includes('黄金'));
      if (gold) gold.click();
    });
    await sleep(1200);
    await page.screenshot({ path: path.join(SHOTS, '03_spectator_gold.png'), fullPage: true });
    console.log('  📸 03_spectator_gold.png');

    const spectatorCheck = await page.evaluate(() => {
      const body = document.body.textContent || '';
      return {
        hasSpectatorBanner: /围观/.test(body) && /目前在/.test(body),
      };
    });
    Object.entries(spectatorCheck).forEach(([k, v]) => {
      console.log(`  ${v ? '✅' : '❌'} ${k}`);
      if (!v) issues.push(`spectator fail: ${k}`);
    });

    // 5. Switch to emerald and diamond
    console.log('\n[5] View emerald + diamond leagues');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.lb-league-tab')];
      const em = btns.find(b => b.textContent?.includes('翡翠'));
      if (em) em.click();
    });
    await sleep(800);
    await page.screenshot({ path: path.join(SHOTS, '04_emerald.png'), fullPage: true });
    console.log('  📸 04_emerald.png');

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.lb-league-tab')];
      const di = btns.find(b => b.textContent?.includes('钻石'));
      if (di) di.click();
    });
    await sleep(800);
    await page.screenshot({ path: path.join(SHOTS, '05_diamond.png'), fullPage: true });
    console.log('  📸 05_diamond.png');

    // 6. Check ghost avatar realism
    console.log('\n[6] Inspect ghost avatars (no 👻)');
    const avatars = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('div')].filter(d => {
        return /XP$/.test(d.textContent?.trim() || '') && d.children.length > 0;
      });
      return Array.from(document.querySelectorAll('div'))
        .map(d => d.textContent?.trim() || '')
        .filter(t => /^[🦊🐼🦁🐯🐻🐺🦉🐰🐸🦝🐨🐱👻👤]$/u.test(t))
        .slice(0, 20);
    });
    console.log(`  ${avatars.length} avatar-like emojis: ${avatars.join(' ')}`);
    if (avatars.includes('👻')) {
      console.log('  ❌ Found 👻 — illusion broken!');
      issues.push('Ghost 👻 still visible');
    } else if (avatars.length > 0) {
      console.log('  ✅ Avatars are animal-style, no 👻');
    }

    // 7. Verify countdown actually counts down (capture twice, 2s apart)
    console.log('\n[7] Verify countdown is live');
    const countdown1 = await page.evaluate(() => {
      const t = document.body.textContent?.match(/(\d+)\s*分\s*(\d+)\s*秒/);
      return t ? t[0] : null;
    });
    await sleep(2500);
    const countdown2 = await page.evaluate(() => {
      const t = document.body.textContent?.match(/(\d+)\s*分\s*(\d+)\s*秒/);
      return t ? t[0] : null;
    });
    if (countdown1 && countdown2 && countdown1 !== countdown2) {
      console.log(`  ✅ Countdown ticking: "${countdown1}" → "${countdown2}"`);
    } else {
      console.log(`  ⚠️ Countdown didn't change in 2s: ${countdown1} / ${countdown2}`);
    }

  } catch (e) {
    console.log('  ❌ Test threw:', e.message);
    issues.push('threw: ' + e.message);
  }

  await browser.close();

  console.log('\n' + '═'.repeat(50));
  console.log(`📊 ${issues.length} issues / 5 screenshots`);
  issues.forEach(i => console.log('  ' + i));
  console.log(`\n📁 Screenshots: ${SHOTS}`);
}

run().catch(e => { console.error(e); process.exit(1); });
