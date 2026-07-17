// E2E: build-update pill. Runs a real server (fast build-check tick), then
// simulates a new build by rewriting dist/build-manifest.json with a different
// buildId. Asserts the server flips buildUpdateReady, the "restart to load" pill
// appears in the browser, and clicking it copies `cc restart`.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 2742;
const MANIFEST = 'dist/build-manifest.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const original = fs.readFileSync(MANIFEST, 'utf-8');

let results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

// Fast build-check tick so we don't wait 20s.
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)],
  { stdio: 'ignore', env: { ...process.env, CLDCTRL_BUILD_CHECK_MS: '800' } });
await sleep(3800);

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const toasts = [];
page.on('console', () => {});

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await sleep(1500);

  const before = await page.evaluate(async () => (await (await fetch('/api/overview')).json()).buildUpdateReady);
  check('buildUpdateReady false initially', before === false || before === undefined, String(before));
  check('no restart pill initially', !(await page.$('.restart-pill')));

  // Simulate a NEW build landing on disk: change the buildId.
  const m = JSON.parse(original);
  fs.writeFileSync(MANIFEST, JSON.stringify({ ...m, buildId: 'deadbeefdeadbeef', builtAt: new Date().toISOString() }, null, 2));
  console.log('  … rewrote manifest with a new buildId; waiting for the server tick + poll');

  // Wait for the server to detect (800ms tick) + the page to poll (3s).
  let flipped = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const r = await page.evaluate(async () => (await (await fetch('/api/overview')).json()).buildUpdateReady);
    if (r === true) { flipped = true; break; }
  }
  check('server flipped buildUpdateReady=true', flipped);

  // The pill should appear on the next render (3s poll drives it).
  await page.waitForSelector('.restart-pill', { timeout: 8000 }).catch(() => {});
  check('restart pill visible', !!(await page.$('.restart-pill')));
  const pillText = await page.$eval('.restart-pill', el => el.textContent.trim()).catch(() => '');
  check('pill says "restart to load"', /restart to load/i.test(pillText), pillText);

  // Click it → should copy `cc restart` (toast).
  await page.$eval('.restart-pill', el => el.click());
  await sleep(500);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
  check('clicking copies `cc restart`', clip === 'cc restart', clip);
} catch (e) {
  check('no exception', false, String(e));
} finally {
  fs.writeFileSync(MANIFEST, original); // restore real manifest
  await browser.close();
  srv.kill();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
