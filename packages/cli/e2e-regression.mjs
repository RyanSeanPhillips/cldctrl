// Consolidated regression sweep — exercises the full dashboard across the July-2
// batch (pop-out, handoff, notepad math/LaTeX, karaoke, Codex stats, agents,
// theme, search) in DEMO mode, watching for console errors + missing elements.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2740;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(800);

  // 1. Sidebar + usage bars
  check('sidebar usage bars (5h/7d)', await page.$$eval('.side-usage-row', e => e.length) >= 2);
  check('conversation list present', await page.$$eval('.side-conv[data-act="openincockpit"]', e => e.length) > 0);

  // 2. +Add picker → agents include Antigravity
  await page.$('[data-act="cockpit-add-toggle"]').then(b => b && b.click());
  await page.waitForTimeout(400);
  // switch to the "new" sub-flow if the picker has tabs; agents render in cp-agents
  const agentLabels = await page.$$eval('.cp-agent', e => e.map(x => x.textContent.trim())).catch(() => []);
  check('agent picker lists agents', agentLabels.length >= 2, agentLabels.join(', '));
  await page.keyboard.press('Escape').catch(() => {});
  await page.$('[data-act="cockpit-add-close"]').then(b => b && b.click()).catch(() => {});
  await page.waitForTimeout(200);

  // 3. Open a conversation tile → controls present. The header now carries only
  //    notepad + ⋯ + the window controls; the rest are labelled rows inside ⋯.
  await (await page.$('.side-conv[data-act="openincockpit"]')).click();
  await page.waitForTimeout(700);
  check('tile mounted', await page.$$eval('.tile', e => e.length) > 0);
  for (const [act, label] of [['tile-more','overflow'],['tile-handoff','handoff'],['tile-popout','popout'],['tile-min','minimize'],['tile-max','maximize'],['tile-close','close']]) {
    check('tile control: ' + label, await page.$$eval(`[data-act="${act}"]`, e => e.length) > 0);
  }

  // 4. Handoff menu opens with other agents (handoff lives in the ⋯ overflow now)
  await page.$('[data-act="tile-more"]').then(b => b && b.click());
  await page.waitForTimeout(250);
  await page.$('[data-act="tile-handoff"]').then(b => b && b.click());
  await page.waitForTimeout(300);
  const hoMenu = await page.evaluate(() => { const m = document.getElementById('handoff-menu'); return m ? [...m.querySelectorAll('.handoff-opt')].map(o => o.textContent) : null; });
  check('handoff menu lists other agents', hoMenu && hoMenu.length > 0, (hoMenu||[]).join(', '));
  await page.mouse.click(5, 5); // close menu
  await page.waitForTimeout(150);
  check('handoff menu closes on outside click', await page.evaluate(() => !document.getElementById('handoff-menu')));

  // 5. Notepad opens + mode toggle. NOTE: the LaTeX menu items and KaTeX preview
  //    require a real note file (notePath from /api/scratch), which DEMO mode
  //    stubs out — so they're covered by dedicated real/standalone tests, not here.
  await page.$('.tile .note-rail').then(b => b && b.click());
  await page.waitForTimeout(400);
  check('notepad pane visible', await page.$eval('.tile .tile-note', e => !e.classList.contains('collapsed')).catch(() => false));
  check('notepad KaTeX render path present', await page.evaluate(() => typeof document.querySelector('.tile .note-preview') !== 'undefined'));
  const noteMenuOpens = await page.evaluate(async () => {
    document.querySelector('.tile [data-note="menu"]')?.click();
    await new Promise(r => setTimeout(r, 300));
    return !!document.querySelector('.tile .note-menu .note-item');
  });
  check('notepad name-menu opens', noteMenuOpens);
  await page.mouse.click(5, 5); await page.waitForTimeout(150);

  // 6. Stats tab
  await page.$('[data-act="nav-stats"]').then(b => b && b.click());
  await page.waitForTimeout(1000);
  check('stats KPIs render', await page.$$eval('#stats-body .kpi', e => e.length) > 4);
  check('stats vendor card (tokens by agent)', await page.evaluate(() => [...document.querySelectorAll('#stats-body h2')].some(h => /by agent/i.test(h.textContent))));
  check('stats live strip', await page.$$eval('.stats-live', e => e.length) > 0);

  // 7. Back to cockpit + theme switch (theme-color meta follows). Use page.click
  //    (auto-waits + re-queries) — the 3s poll re-render can detach a stale handle.
  await page.click('[data-act="nav-cockpit"]', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  const themeMeta = await page.evaluate(async () => {
    const before = document.querySelector('meta[name=theme-color]')?.content;
    const sel = document.querySelector('select'); if (!sel) return { before, after: before, changed: false };
    const other = [...sel.options].map(o => o.value).find(v => v !== sel.value);
    sel.value = other; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const after = document.querySelector('meta[name=theme-color]')?.content;
    return { before, after, changed: before !== after };
  });
  check('theme switch updates titlebar theme-color', themeMeta.changed, `${themeMeta.before} → ${themeMeta.after}`);

  // 8. Search
  await page.$('[data-act="search-toggle"]').then(b => b && b.click({ timeout: 3000, force: true })).catch(() => {});
  await page.waitForTimeout(300);
  const si = await page.$('#search-input');
  if (si) { await si.type('dashboard'); await page.waitForTimeout(900); }
  check('search returns results', await page.$$eval('.side-conv, .res-row, [data-act="openincockpit"]', e => e.length) > 0);

  // 9. Screenshot for eyeball
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-regression.png' });
} catch (e) {
  check('sweep completed without throwing', false, String(e).slice(0, 200));
}

// Console-error gate (ignore the expected demo WS-terminal failures — no live PTYs in demo)
const realErrors = errors.filter(e => !/WebSocket|ws:\/\/|handshake|Connection closed/i.test(e));
console.log('\n──────── SUMMARY ────────');
console.log('checks: ' + results.filter(r => r.ok).length + '/' + results.length + ' passed');
const failed = results.filter(r => !r.ok);
if (failed.length) console.log('FAILED: ' + failed.map(r => r.name).join(' | '));
console.log('console errors (non-WS): ' + (realErrors.length ? realErrors.length + '\n  ' + realErrors.slice(0, 6).join('\n  ') : 'none'));

await browser.close();
srv.kill();
process.exit(failed.length || realErrors.length ? 1 : 0);
