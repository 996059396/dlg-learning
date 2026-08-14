const puppeteer = require('puppeteer');

async function testConsole() {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  page.on('console', msg => {
    console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.err(`[Browser PageError] ${err.toString()}`);
  });

  console.log('Navigating to Home...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });

  console.log('Navigating to CourseTree...');
  await page.goto('http://localhost:5173/course/electrician_basics', { waitUntil: 'networkidle0' });

  console.log('Navigating to LessonPlayer...');
  await page.goto('http://localhost:5173/course/electrician_basics/unit/u1_meter_basics/lesson/l1_intro', { waitUntil: 'networkidle0' });

  console.log('Done.');
  await browser.close();
}

testConsole().catch(console.error);