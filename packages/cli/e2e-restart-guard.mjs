// Restart safety gate + per-project agent launch.
//
// A restart HARD-KILLS every agent PTY, so an in-flight turn is lost (the
// conversation itself resumes from disk). The ⏻ menu warned about open sessions;
// the "restart to load" notice did not — and that's the one clicked casually the
// moment a build lands. Both now route through a confirm that offers wait / force
// / cancel, and stays out of the way when nothing is mid-turn.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2757;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const results = [];
const check = (n, ok, x = '') => { results.push({ n, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  — ' + x : '')); };
const vis = (s) => page.$eval(s, (e) => !!(e.offsetWidth || e.offsetHeight)).catch(() => false);

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(900);

  // demo reports buildUpdateReady, so the notice is present
  check('"new build ready" notice present', await vis('.side-notice.restart'));

  // ── no tiles open → no gate, restart goes straight through ──
  await page.click('.side-notice.restart');
  await page.waitForTimeout(600);
  check('idle dashboard: no confirm, restart proceeds', (await vis('#restart-confirm')) === false);
  // demo refuses the restart, so the overlay must clear itself
  await page.waitForTimeout(1200);
  check('demo refusal clears the overlay', await page.evaluate(() => {
    const e = document.getElementById('cldctrl-lifecycle-overlay');
    return !e || e.style.display === 'none';
  }));

  // ── a working conversation → the gate appears ───────────────
  await page.click('.side-conv[data-act="openincockpit"] >> nth=0');
  await page.waitForTimeout(900);
  await page.click('.side-notice.restart');
  await page.waitForTimeout(600);
  check('mid-turn work: confirm dialog appears', await vis('#restart-confirm'));
  const txt = await page.$eval('#restart-confirm', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  check('it names the risk (interrupted turn, history kept)',
    /interrupt/i.test(txt) && /(history|reopen)/i.test(txt), txt.slice(0, 110));
  const btns = await page.$$eval('#restart-confirm [data-rc]', (e) => e.map((x) => x.dataset.rc));
  check('offers wait / force / cancel', ['wait', 'force', 'cancel'].every((b) => btns.includes(b)), btns.join(','));

  // cancel leaves everything alone
  await page.click('#restart-confirm [data-rc="cancel"]');
  await page.waitForTimeout(400);
  check('cancel dismisses without restarting', (await vis('#restart-confirm')) === false
    && (await page.evaluate(() => { const e = document.getElementById('cldctrl-lifecycle-overlay'); return !e || e.style.display === 'none'; })));

  // "wait until idle" keeps the dialog up and cancellable (never a trap)
  await page.click('.side-notice.restart'); await page.waitForTimeout(500);
  await page.click('#restart-confirm [data-rc="wait"]'); await page.waitForTimeout(900);
  const waiting = await vis('#restart-confirm');
  const status = await page.$eval('#restart-confirm .confirm-status', (e) => e.textContent).catch(() => '');
  check('"wait until idle" stays open and explains itself', waiting && /waiting/i.test(status), status.slice(0, 80));
  check('force is still reachable while waiting', await vis('#restart-confirm [data-rc="force"]'));
  await page.click('#restart-confirm [data-rc="cancel"]'); await page.waitForTimeout(400);
  check('waiting can be cancelled', (await vis('#restart-confirm')) === false);

  // ── per-project launch with another agent ──────────────────
  await page.click('.proj-row >> nth=0');
  await page.waitForTimeout(1200);
  check('project detail opens', await vis('.detail-card'));
  check('"New here" split button present', await vis('.split-btn .split-main'));
  check('agent ⌄ present on the split button', await vis('.split-btn .split-caret'));
  await page.click('.split-btn .split-caret');
  await page.waitForTimeout(400);
  const rows = await page.$$eval('.split-btn .tile-menu .tile-mi', (e) => e.map((x) => ({ t: x.textContent.trim(), a: x.dataset.agent })));
  check('menu offers Codex + Antigravity', rows.length >= 2 && rows.some((r) => r.a === 'codex') && rows.some((r) => r.a === 'antigravity'),
    rows.map((r) => r.a + ':' + r.t).join(' | '));

  const before = await page.$$eval('.tile', (e) => e.length);
  await page.click('.split-btn .tile-menu [data-agent="codex"]');
  await page.waitForTimeout(1200);
  const tiles = await page.evaluate(() => {
    const cp = JSON.parse(localStorage.getItem('cldctrl.session.v1') || '{}')?.cockpit?.tiles || [];
    return cp.map((t) => ({ agent: t.agent, title: t.title, kind: t.kind }));
  });
  check('launching with Codex adds a tile carrying agent=codex',
    tiles.some((t) => t.agent === 'codex' && t.kind === 'new'), JSON.stringify(tiles.slice(-2)));
  check('the new tile is labelled with its agent',
    tiles.some((t) => t.agent === 'codex' && /codex/i.test(t.title)), JSON.stringify(tiles.slice(-1)));
  check('a tile was actually added', await page.$$eval('.tile', (e) => e.length) > before);
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-agent-launch.png' });
} catch (e) {
  check('harness completed', false, String(e));
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
await browser.close();
srv.kill();
process.exit(pass === results.length ? 0 : 1);
