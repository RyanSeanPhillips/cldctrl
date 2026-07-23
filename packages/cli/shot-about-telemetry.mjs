// About/Help popover — informational only (no opt-out toggle): app version, a plain
// anonymous-usage disclosure line, and links. Verifies the disclosure copy + that
// there is NO telemetry toggle.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2744;
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
  await page.waitForTimeout(800);

  check('About button present in sidebar footer', await page.$$eval('[data-act="about-menu"]', (e) => e.length) === 1);
  await page.click('[data-act="about-menu"]');
  await page.waitForTimeout(300);
  check('About popover opens', await page.$('#about-menu') !== null);

  const hd = await page.$eval('#about-menu .power-menu-hd', (e) => e.textContent).catch(() => '');
  check('shows app name + version', /CLD CTRL/.test(hd) && /v\d/.test(hd), hd);

  const note = await page.$eval('#about-menu .about-note', (e) => e.textContent).catch(() => '');
  check('discloses the anonymous head count + what is NOT sent',
    /anonymous/i.test(note) && /head count/i.test(note) && /never your code/i.test(note), note);

  check('there is NO opt-out toggle (no opt-out offered)', (await page.$$eval('.about-toggle, [data-act="telemetry-toggle"]', (e) => e.length)) === 0);
  check('About links present', await page.$$eval('#about-menu .about-link', (e) => e.length) >= 1);

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/demo-about-panel.png' });

  await page.mouse.click(700, 400);
  await page.waitForTimeout(200);
  check('outside click closes the About popover', await page.$('#about-menu') === null);
} catch (e) {
  check('script ran without throwing', false, String(e));
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  try { srv.kill(); } catch {}
  process.exit(passed === results.length ? 0 : 1);
}
