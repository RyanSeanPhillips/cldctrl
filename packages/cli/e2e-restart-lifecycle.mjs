// E2E: server-restart detection. Loads the dashboard against demo server A,
// replaces it with demo server B (new instanceId) on the same port, and asserts
// the page shows the reconnect/updating overlay and then RELOADS to resync.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2741;
const startServer = () => spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

let srv = startServer();
await sleep(3500);

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
let navCount = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navCount++; });
let sawOverlay = false;
// Poll the DOM for the overlay appearing at any point during the restart.
const overlayWatch = setInterval(async () => {
  try { if (await page.$('#cldctrl-lifecycle-overlay')) { const disp = await page.$eval('#cldctrl-lifecycle-overlay', el => getComputedStyle(el).display); if (disp !== 'none') sawOverlay = true; } } catch {}
}, 150);

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await sleep(3500); // let a poll or two run so `known` instanceId is set

  const idA = await page.evaluate(async () => (await (await fetch('/api/overview')).json()).instanceId);
  check('server A has instanceId', !!idA, idA);
  const navBefore = navCount;

  // Set a sentinel that only survives until a reload.
  await page.evaluate(() => { window.__preRestart = true; });
  check('no overlay before restart', !(await page.$('#cldctrl-lifecycle-overlay').then(e => e && page.$eval('#cldctrl-lifecycle-overlay', x => getComputedStyle(x).display !== 'none')).catch(() => false)));

  // Replace the server: kill A, start B on the same port (new instanceId).
  srv.kill();
  await sleep(1200);
  srv = startServer();
  console.log('  … server B starting; waiting for the page to detect + reload');

  // Wait up to 30s for the reload (sentinel cleared).
  let reloaded = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    let sentinel;
    try { sentinel = await page.evaluate(() => window.__preRestart); } catch { sentinel = undefined; /* mid-navigation */ }
    if (sentinel === undefined) { reloaded = true; break; }
  }
  check('page reloaded after server replaced', reloaded);
  check('overlay was shown during restart', sawOverlay);

  // After reload, page should reconnect to server B and render again.
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  const idB = await page.evaluate(async () => (await (await fetch('/api/overview')).json()).instanceId);
  check('reconnected to server B (different instanceId)', idB && idB !== idA, `${idA} -> ${idB}`);
} catch (e) {
  check('no exception', false, String(e));
} finally {
  clearInterval(overlayWatch);
  await browser.close();
  srv.kill();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
