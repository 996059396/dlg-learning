#!/usr/bin/env node
// Automated Browser Screenshot Test for DLG Learning System
// Takes screenshots of all major pages and tests UI interactions

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const BASE = 'http://localhost:5173';

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`  📸 ${name}.png`);
  return filepath;
}

async function clickText(page, text) {
  try {
    // Use evaluate to find element by text content
    const clicked = await page.evaluate((t) => {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (el.textContent?.trim() === t && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      // Try contains match
      for (const el of els) {
        if (el.textContent?.includes(t) && el.offsetParent !== null && el.tagName === 'BUTTON') {
          el.click();
          return true;
        }
      }
      return false;
    }, text);
    if (!clicked) console.log(`  ⚠️ Could not click: "${text}"`);
    return clicked;
  } catch (e) {
    console.log(`  ⚠️ Click error "${text}": ${e.message}`);
    return false;
  }
}

async function run() {
  console.log('\n🌐 DLG Browser Screenshot Test Suite\n');
  console.log('═'.repeat(50));

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  let passed = 0;
  let failed = 0;

  try {
    // ─── 1. Home Page ───
    console.log('\n📋 Home Page');
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await sleep(1500);
    await screenshot(page, '01_home');
    passed++;

    // Verify key elements
    const hasTitle = await page.$eval('body', el => el.textContent.includes('DLG电工'));
    console.log(`  ${hasTitle ? '✅' : '⚠️'} Title "DLG电工" ${hasTitle ? 'found' : 'NOT found'}`);
    const hasStreak = await page.$eval('body', el => el.textContent.includes('学习连胜'));
    console.log(`  ${hasStreak ? '✅' : '⚠️'} Streak banner ${hasStreak ? 'found' : 'NOT found'}`);

    // ─── 2. Click into Course ───
    console.log('\n📋 Course Tree');
    await clickText(page, '初级电工理论');
    await sleep(1200);
    await screenshot(page, '02_course_tree');
    passed++;

    const hasLessons = await page.$eval('body', el =>
      el.textContent.includes('初识万用表') &&
      el.textContent.includes('测一节电池') &&
      el.textContent.includes('致命禁忌') &&
      el.textContent.includes('测量电阻')
    );
    console.log(`  ${hasLessons ? '✅' : '❌'} All 4 lessons ${hasLessons ? 'visible' : 'NOT all visible'}`);
    if (!hasLessons) failed++;

    // ─── 3. Start Lesson 1 ───
    console.log('\n📋 Lesson Player (l1_intro: 初识万用表)');
    await clickText(page, '初识万用表');
    await sleep(1500);
    await screenshot(page, '03_lesson_intro_info');
    passed++;

    // Info node - click continue
    const hasInfoCard = await page.$eval('body', el => el.textContent.includes('万用表是电工'));
    console.log(`  ${hasInfoCard ? '✅' : '❌'} Info card ${hasInfoCard ? 'shown' : 'NOT shown'}`);
    if (!hasInfoCard) failed++;

    // Click "继续" to go to first question (Match question)
    await clickText(page, '继续');
    await sleep(1000);
    await screenshot(page, '04_lesson_match_question');
    passed++;

    // Match question: "显示屏" -> "显示测量数值"
    const hasMatch = await page.$eval('body', el => el.textContent.includes('显示屏'));
    console.log(`  ${hasMatch ? '✅' : '❌'} Match options ${hasMatch ? 'shown' : 'NOT shown'}`);
    if (!hasMatch) failed++;

    // Click first match pair
    await clickText(page, '显示屏');
    await clickText(page, '显示测量数值');
    await sleep(1000);
    await screenshot(page, '05_lesson_match_action');
    passed++;

    // ─── 4. Bottom Navigation ───
    console.log('\n📋 Navigation');

    // Go back to course tree first
    // Navigate via bottom nav to shop
    await page.goto(BASE + '/shop', { waitUntil: 'networkidle2' });
    await sleep(1000);
    await screenshot(page, '06_shop');
    passed++;
    const hasShopItems = await page.$eval('body', el => el.textContent.includes('连胜冷冻块'));
    console.log(`  ${hasShopItems ? '✅' : '❌'} Shop items ${hasShopItems ? 'loaded' : 'NOT loaded'}`);
    if (!hasShopItems) failed++;

    // Leaderboard
    await page.goto(BASE + '/leaderboard', { waitUntil: 'networkidle2' });
    await sleep(1000);
    await screenshot(page, '07_leaderboard');
    passed++;
    const hasLb = await page.$eval('body', el => el.textContent.includes('青铜'));
    console.log(`  ${hasLb ? '✅' : '❌'} Leaderboard ${hasLb ? 'loaded' : 'NOT loaded'}`);
    if (!hasLb) failed++;

    // Profile
    await page.goto(BASE + '/profile', { waitUntil: 'networkidle2' });
    await sleep(1000);
    await screenshot(page, '08_profile');
    passed++;
    const hasProfileStats = await page.$eval('body', el => el.textContent.includes('小电工'));
    console.log(`  ${hasProfileStats ? '✅' : '❌'} Profile ${hasProfileStats ? 'loaded' : 'NOT loaded'}`);
    if (!hasProfileStats) failed++;

    // ─── 5. Mistake Review ───
    console.log('\n📋 Mistake Review');
    await page.goto(BASE + '/review', { waitUntil: 'networkidle2' });
    await sleep(1000);
    await screenshot(page, '09_mistake_review');
    passed++;
    const hasReview = await page.$eval('body', el =>
      el.textContent.includes('错题医疗包') || el.textContent.includes('没有待复习的错题')
    );
    console.log(`  ${hasReview ? '✅' : '❌'} Mistake review ${hasReview ? 'loaded' : 'NOT loaded'}`);
    if (!hasReview) failed++;

    // ─── 6. Safety Lesson: Danger Simulation ───
    console.log('\n📋 Danger Simulation (l3_safety)');
    await page.goto(BASE + '/course/electrician_basics/unit/u1_meter_basics/lesson/l3_safety', { waitUntil: 'networkidle2' });
    await sleep(1500);
    await screenshot(page, '10_danger_warning');
    passed++;

    // Click past the info card
    await clickText(page, '继续');
    await sleep(1000);
    await screenshot(page, '11_danger_sim');
    passed++;

    const hasDangerWarning = await page.$eval('body', el =>
      el.textContent.includes('红表笔在') || el.textContent.includes('20A')
    );
    console.log(`  ${hasDangerWarning ? '✅' : '⚠️'} Danger sim ${hasDangerWarning ? 'elements present' : 'elements may be missing'}`);

  } catch (e) {
    console.log(`\n  ❌ Error: ${e.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log(`\n📊 Browser Tests: ${passed} screenshots captured, ${failed} issues found\n`);
  console.log(`📁 Screenshots saved to: ${SCREENSHOTS_DIR}`);

  return failed === 0;
}

run().then(success => {
  if (!success) process.exit(1);
});
