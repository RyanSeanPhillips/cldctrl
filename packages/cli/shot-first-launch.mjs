// First-launch view in the demo: a fresh profile has an empty localStorage, so the
// one-time privacy disclosure shows. Capture it, then prove ✕ dismisses it for good.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2743;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const results = [];
const check = (name, ok, extra = '') => { results.push({ ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(900);

  const shown = await page.$$eval('.side-notice.privacy', (e) => e.length);
  check('privacy disclosure shows on first launch', shown === 1);
  const text = await page.$eval('.side-notice.privacy .notice-t', (e) => e.innerText).catch(() => '');
  check('note discloses anonymous count + what is NOT sent', /anonymous/i.test(text) && /code|chats/i.test(text), JSON.stringify(text));

  // Whole-dashboard first-launch view + a tight crop of the disclosure.
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/demo-first-launch.png' });
  const box = await page.$eval('.side-usage', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/demo-first-launch-notice.png', clip: box });

  // Dismiss → gone, and stays gone across a re-render (it persists in localStorage).
  await page.click('.side-notice.privacy [data-act="privacy-ack"]');
  await page.waitForTimeout(400);
  check('✕ dismisses the disclosure', (await page.$$eval('.side-notice.privacy', (e) => e.length)) === 0);
  await page.waitForTimeout(3200); // force at least one 3s poll re-render
  check('stays dismissed after a poll re-render', (await page.$$eval('.side-notice.privacy', (e) => e.length)) === 0);
  const ack = await page.evaluate(() => { try { return localStorage.getItem('cldctrl-privacy-ack'); } catch { return null; } });
  check('acknowledgement persisted', ack === '1');
} catch (e) {
  check('script ran without throwing', false, String(e));
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  try { srv.kill(); } catch {}
  process.exit(passed === results.length ? 0 : 1);
}
