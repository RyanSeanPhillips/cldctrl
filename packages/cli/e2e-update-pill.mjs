// E2E: "update available" pill. The server only reports updateAvailable when a
// newer version is actually published, so we can't drive it live — instead we
// intercept /api/overview and inject updateAvailable, then assert the pill
// renders, the ✕ dismiss persists (survives a re-poll), and a fresh version
// re-shows it. Boots the REAL built server; no Claude session is launched.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const PORT = 2629;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const ok = (b) => (b ? 'PASS' : 'FAIL'); const R = {};
let FAKE = '9.9.9';
try {
  // Rewrite the overview payload to advertise an update.
  await page.route('**/api/overview', async (route) => {
    const resp = await route.fetch();
    let json = {};
    try { json = await resp.json(); } catch { /* first paint may 500 briefly */ }
    json.updateAvailable = FAKE;
    await route.fulfill({ response: resp, body: JSON.stringify(json), headers: { 'content-type': 'application/json' } });
  });
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.waitForTimeout(600);

  R['pill shows when update available'] = await page.$eval('.update-pill', (e) => !!e).catch(() => false);
  R['pill shows the version'] = ((await page.$eval('.update-pill .up-ver', (e) => e.textContent).catch(() => '')) || '').includes(FAKE);

  // Dismiss and confirm it persists across a re-poll (3s tick re-renders).
  await page.click('.update-x');
  await page.waitForTimeout(3400);
  R['dismiss hides the pill (survives re-poll)'] = (await page.$$('.update-pill')).length === 0;
  R['dismiss persisted to localStorage'] = (await page.evaluate(() => localStorage.getItem('cldctrl-dismissed-update'))) === FAKE;

  // A NEWER version should re-show the pill (dismissal is per-version).
  FAKE = '9.9.10';
  await page.waitForTimeout(3400);
  R['newer version re-shows the pill'] = await page.$eval('.update-pill', (e) => !!e).catch(() => false);

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-update-pill.png' });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.waitForTimeout(200);
  R['no console errors'] = errs.length === 0;
} catch (e) { console.log('ERR', String(e)); R['threw'] = false; }
console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(R)) console.log(ok(v).padEnd(5), k);
await browser.close(); srv.kill();
