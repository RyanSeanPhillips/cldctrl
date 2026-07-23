// Restart-button recovery.
//
// REGRESSION: pressing "restart to load" showed an "Updating…" spinner that could
// never be escaped — onOverviewError returned early forever while manualMode was
// 'restarting', so if the restart didn't take, the only way out was closing the
// window. Both failure shapes must now land on a recoverable state:
//   A. server never comes back  → polls keep FAILING  → "didn't come back" + Retry
//   B. restart never happened   → polls keep SUCCEEDING with the SAME instanceId
//                                 → "Restart didn't take" + Try again / Keep using it
// Driven against the real bundle by calling the lifecycle module's own entry
// points with a stubbed clock, so we exercise the shipped logic, not a copy.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2742;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 820 } })).newPage();
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

// The overlay is inline-styled and id'd, so we can read its state from the DOM.
const overlay = () => page.evaluate(() => {
  const el = document.getElementById('cldctrl-lifecycle-overlay');
  if (!el || el.style.display === 'none') return null;
  return {
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    retry: !!el.querySelector('#cldctrl-lifecycle-retry'),
    dismiss: !!el.querySelector('#cldctrl-lifecycle-dismiss'),
  };
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(700);

  // The app ships as one bundle, so main.ts exposes the lifecycle module as a
  // test seam — we drive the REAL shipped state machine, not a copy of it.
  const ok = await page.evaluate(() => { window.__lc = window.cldctrlLifecycle; return !!window.__lc?.announceRestarting; });
  check('lifecycle state machine reachable', ok);

  // ── A. server goes away and never returns ────────────────
  // Freeze time forward so the 30s "not coming back" budget elapses instantly.
  await page.evaluate(() => { window.__realNow = Date.now; window.__lc.announceRestarting(); });
  let ov = await overlay();
  check('A: restart shows the Updating… spinner', !!ov && /Updating/.test(ov.text), ov?.text?.slice(0, 60));
  check('A: spinner has no escape yet (expected)', ov && !ov.retry);

  await page.evaluate(() => {
    // jump the clock past RESTART_DEAD_MS (30s) — the module reads Date.now()
    const base = window.__realNow();
    Date.now = () => base + 45_000;
    for (let i = 0; i < 3; i++) window.__lc.onOverviewError();
  });
  ov = await overlay();
  check('A: escalates to a recoverable failure state', !!ov && ov.retry && !/Updating/.test(ov.text), ov?.text?.slice(0, 80));
  // The failure must LATCH: later failed polls must not downgrade it back to
  // "Reconnecting…", and a later successful poll must not silently dismiss it.
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__lc.onOverviewError(); });
  ov = await overlay();
  check('A: stays failed across further failed polls', !!ov && ov.retry && !/Reconnecting/.test(ov.text), ov?.text?.slice(0, 60));
  await page.waitForTimeout(3500); // let a real (successful) poll land
  ov = await overlay();
  check('A: a healthy poll does not dismiss it behind your back', !!ov && ov.retry, ov ? ov.text.slice(0, 50) : 'overlay gone');

  // ── B. restart silently didn't happen ───────────────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(700);
  // Must use the server's REAL instanceId: the live 3s poll has already recorded
  // it, so feeding a made-up id would look like a genuine server swap and trigger
  // a reload instead of the case under test.
  const realId = await page.evaluate(async () => (await (await fetch('/api/overview')).json()).instanceId);
  const same = await page.evaluate((id) => {
    window.__lc = window.cldctrlLifecycle;
    window.__lc.onOverview(id);          // establish the known instance
    window.__lc.announceRestarting();
    const base = Date.now();
    Date.now = () => base + 20_000;      // past RESTART_NOOP_MS (15s)
    window.__lc.onOverview(id);          // same process answered again
    return true;
  }, realId);
  ov = await overlay();
  check('B: same-instance after grace → "restart didn\'t take"', same && !!ov && /didn.t take/i.test(ov.text), ov?.text?.slice(0, 80));
  check('B: offers Try again', !!ov?.retry);
  check('B: offers a non-destructive "Keep using it"', !!ov?.dismiss);

  await page.click('#cldctrl-lifecycle-dismiss');
  await page.waitForTimeout(200);
  check('B: dismiss clears the overlay without reloading', (await overlay()) === null);
  check('B: page still usable after dismiss', await page.$eval('.side-usage', (e) => !!e).catch(() => false));
} catch (e) {
  check('harness completed', false, String(e));
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
await browser.close();
srv.kill();
process.exit(pass === results.length ? 0 : 1);
