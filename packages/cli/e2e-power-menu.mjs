// E2E: the ⏻ power menu — full server lifecycle from the browser.
// Phase 1: menu opens with Restart/Stop. Phase 2: click Restart → server really
// restarts (new instanceId) and the page reloads + reconnects. Phase 3: click
// Stop → server goes down and the page shows the "stopped" overlay.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

const PORT = 2743;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killPort = () => { try { execSync(`for /f "tokens=5" %a in ('netstat -ano -p tcp ^| findstr LISTENING ^| findstr :${PORT}') do taskkill /PID %a /T /F`, { shell: 'cmd.exe', stdio: 'ignore' }); } catch {} };

let results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };
const idNow = (page) => page.evaluate(async () => { try { return (await (await fetch('/api/id')).json()).instanceId; } catch { return null; } });

killPort();
spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await sleep(3800);

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await sleep(2500);

  // ── Phase 1: menu ──
  check('power button present', !!(await page.$('[data-act="power-menu"]')));
  await page.$eval('[data-act="power-menu"]', el => el.click());
  await sleep(300);
  check('power menu opens', !!(await page.$('.power-menu')));
  check('menu has Restart option', !!(await page.$('[data-act="power-restart"]')));
  check('menu has Stop option', !!(await page.$('[data-act="power-stop"]')));
  // Toggle closed then reopen (idempotent open/close)
  await page.$eval('[data-act="power-menu"]', el => el.click());
  await sleep(200);
  check('menu toggles closed', !(await page.$('.power-menu')));

  // ── Phase 2: Restart ──
  const idA = await idNow(page);
  check('have instanceId A', !!idA, idA);
  await page.evaluate(() => { window.__sentinel = 'preRestart'; });
  await page.$eval('[data-act="power-menu"]', el => el.click());
  await sleep(250);
  await page.$eval('[data-act="power-restart"]', el => el.click());
  console.log('  … clicked Restart; waiting for the server to bounce + page to reload');
  check('updating overlay shown', await page.$eval('#cldctrl-lifecycle-overlay', el => getComputedStyle(el).display !== 'none').catch(() => false));

  let reloaded = false;
  for (let i = 0; i < 70; i++) {
    await sleep(500);
    let s; try { s = await page.evaluate(() => window.__sentinel); } catch { s = undefined; }
    if (s === undefined) { reloaded = true; break; }
  }
  check('page reloaded after restart', reloaded);
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  const idB = await idNow(page);
  check('server restarted (new instanceId)', idB && idB !== idA, `${idA} -> ${idB}`);

  // ── Phase 3: Stop ──
  await page.$eval('[data-act="power-menu"]', el => el.click());
  await sleep(250);
  await page.$eval('[data-act="power-stop"]', el => el.click());
  console.log('  … clicked Stop; waiting for the server to go down');
  // Server should stop; the page shows the "stopped" overlay.
  let stopped = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { await fetch; } catch {}
    const gone = await page.evaluate(async () => { try { await fetch('/api/id', { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }).catch(() => true);
    if (gone) { stopped = true; break; }
  }
  check('server stopped (port unreachable)', stopped);
  await sleep(1500);
  const overlayTxt = await page.$eval('#cldctrl-lifecycle-overlay', el => el.textContent).catch(() => '');
  check('stopped overlay shown', /stopped/i.test(overlayTxt), overlayTxt.replace(/\s+/g, ' ').slice(0, 60));
} catch (e) {
  check('no exception', false, String(e));
} finally {
  await browser.close();
  killPort();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
