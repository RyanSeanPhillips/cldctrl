// Minimize-to-sidebar + notepad drawer rail.
//
// Covers the two window-management gaps: (1) a conversation could only be CLOSED,
// never parked — minimize keeps the tile mounted (PTY/WS alive) and surfaces it in
// the sidebar list; (2) the notepad could only be closed from the conversation
// header — it now has a drawer rail on its own outer edge.
// DEMO mode: no real agents are spawned.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2741;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };
const visible = (sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)).catch(() => false);

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Open two conversations so we can prove minimize hides ONE, not the grid.
  // The sidebar re-renders on the 3s poll, so element handles go stale — always
  // click through a fresh nth-match selector.
  const rowCount = await page.$$eval('.side-conv[data-act="openincockpit"]', (e) => e.length);
  check('two conversations available to open', rowCount >= 2, rowCount + ' rows');
  await page.click('.side-conv[data-act="openincockpit"] >> nth=0'); await page.waitForTimeout(600);
  await page.click('.side-conv[data-act="openincockpit"] >> nth=1'); await page.waitForTimeout(800);
  const tileIds = await page.$$eval('.tile', (e) => e.map((x) => x.dataset.id));
  check('two tiles mounted', tileIds.length === 2, tileIds.join(' | '));

  check('minimize button rendered', await page.$$eval('[data-act="tile-min"]', (e) => e.length) === 2);

  // ── minimize ──────────────────────────────────────────────
  const id0 = tileIds[0];
  await page.click(`.tile[data-id="${id0.replace(/"/g, '\\"')}"] [data-act="tile-min"]`);
  await page.waitForTimeout(500);
  const st = await page.evaluate((id) => {
    const t = document.querySelector(`.tile[data-id="${id.replace(/"/g, '\\"')}"]`);
    return { exists: !!t, hidden: t ? getComputedStyle(t).display === 'none' : null, cls: t ? t.className : '' };
  }, id0);
  check('minimized tile is still MOUNTED (PTY/WS alive)', st.exists);
  check('minimized tile is hidden from the grid', st.hidden === true, st.cls);
  check('the other tile stays visible', await visible('.tile:not(.minimized)'));

  const parked = await page.$$eval('.side-parked', (e) => e.map((x) => x.textContent.trim()));
  check('sidebar shows a "minimized" chip', parked.length === 1, parked.join(','));
  check('parked sidebar row restores (not re-resumes)', await page.$$eval('[data-act="tile-restore"]', (e) => e.length) === 1);
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-minimize-parked.png' });

  // Clicking an already-open (non-minimized) row must not duplicate the tile.
  if (await page.$('.side-conv[data-act="openincockpit"]')) {
    await page.click('.side-conv[data-act="openincockpit"] >> nth=0');
    await page.waitForTimeout(500);
  }
  check('no duplicate tile for an already-open conversation',
    await page.$$eval('.tile', (e) => e.length) === 2, String(await page.$$eval('.tile', (e) => e.length)));

  // ── restore from the sidebar ──────────────────────────────
  await page.click('[data-act="tile-restore"]');
  await page.waitForTimeout(600);
  check('restored tile is visible again', await page.evaluate((id) => {
    const t = document.querySelector(`.tile[data-id="${id.replace(/"/g, '\\"')}"]`);
    return !!t && getComputedStyle(t).display !== 'none';
  }, id0));
  check('"minimized" chip cleared after restore', await page.$$eval('.side-parked', (e) => e.length) === 0);

  // ── all tiles parked → the grid explains where they went ──
  for (const b of await page.$$('[data-act="tile-min"]')) { await b.click(); await page.waitForTimeout(250); }
  await page.waitForTimeout(400);
  const note = await page.$eval('.cp-parked-note', (e) => e.textContent).catch(() => null);
  check('empty grid explains the parked conversations', !!note && /minimized/.test(note), note || 'missing');
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-minimize-allparked.png' });

  // Restore both for the notepad leg (re-query each time — sidebar rows re-render).
  for (let i = 0; i < 4 && await page.$('[data-act="tile-restore"]'); i++) {
    await page.click('[data-act="tile-restore"] >> nth=0');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(500);
  check('all conversations restored', await page.$$eval('.tile:not(.minimized)', (e) => e.length) === 2);

  // ── notepad drawer rail ───────────────────────────────────
  await page.click('.tile .note-rail');
  await page.waitForTimeout(700);
  check('notepad opens from the rail', await visible('.tile .note-body'));
  check('drawer rail rendered on the notepad', await visible('.tile .note-rail'));
  const railRight = await page.evaluate(() => {
    const note = document.querySelector('.tile .tile-note');
    const rail = document.querySelector('.tile .note-rail');
    const body = document.querySelector('.tile .note-body');
    if (!note || !rail || !body) return null;
    const n = note.getBoundingClientRect(), r = rail.getBoundingClientRect(), b = body.getBoundingClientRect();
    return { railOnOuterEdge: Math.abs(r.right - n.right) < 2, afterBody: r.left >= b.right - 1, overlaps: r.left < b.right - 1 };
  });
  check('rail sits on the notepad OUTER (right) edge', railRight?.railOnOuterEdge === true, JSON.stringify(railRight));
  check('rail does not overlap the editor', railRight?.overlaps === false);
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-notepad-rail.png' });

  await page.click('.tile .note-rail');
  await page.waitForTimeout(500);
  check('rail collapses the notepad', (await visible('.tile .note-body')) === false);
  // The rail itself must SURVIVE the collapse — it's the only way back in.
  check('rail stays visible while collapsed', await visible('.tile .note-rail'));
  check('collapsed drawer keeps a usable footprint',
    await page.$eval('.tile .note-rail', (e) => e.getBoundingClientRect().width >= 12));
  await page.click('.tile .note-rail');
  await page.waitForTimeout(700);
  check('the same rail reopens it', await visible('.tile .note-body'));

  // ── ⋯ overflow menu ──────────────────────────────────────
  // The header used to carry ~12 unlabelled icon buttons; only notepad, ⋯ and the
  // three window controls should remain.
  const headBtns = await page.evaluate(() => {
    const head = document.querySelector('.tile .tile-head');
    if (!head) return { n: -1, acts: [] };
    // Only buttons in the header STRIP (menu rows are .tile-mi, not .btn.icon).
    const btns = [...head.querySelectorAll('.btn.icon')]
      .filter((b) => getComputedStyle(b).display !== 'none' && !b.closest('.tile-menu'));
    return { n: btns.length, acts: btns.map((b) => b.dataset.act) };
  });
  check('header trimmed to ≤5 visible buttons', headBtns.n > 0 && headBtns.n <= 5, headBtns.n + ': ' + headBtns.acts.join(','));
  check('overflow button present', await visible('.tile .tile-more-wrap [data-act="tile-more"]'));
  check('menu starts closed', (await visible('.tile .tile-menu')) === false);
  await page.click('.tile >> nth=0 >> [data-act="tile-more"]');
  await page.waitForTimeout(350);
  check('⋯ opens the menu', await visible('.tile .tile-menu'));
  const rows = await page.$$eval('.tile:nth-of-type(1) .tile-menu .tile-mi',
    (e) => e.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent.trim()));
  check('menu rows carry text labels', rows.length >= 4 && rows.every((r) => r.length > 3), rows.join(' | '));
  check('tile un-clips while the menu is open',
    await page.$eval('.tile.menu-open', (e) => getComputedStyle(e).overflow === 'visible').catch(() => false));
  await page.mouse.click(5, 5); await page.waitForTimeout(300);
  check('menu closes on outside click', (await visible('.tile .tile-menu')) === false);
  check('tile re-clips after close', await page.$$eval('.tile.menu-open', (e) => e.length) === 0);

  // Window controls should be OS-shaped SVGs, not emoji/arrow glyphs.
  const wc = await page.evaluate(() => {
    const g = (a) => document.querySelector(`.tile [data-act="${a}"]`);
    return { min: !!g('tile-min')?.querySelector('svg'), max: !!g('tile-max')?.querySelector('svg'),
             close: (g('tile-close')?.textContent || '').trim() };
  });
  check('minimize/maximize use OS-style SVG glyphs', wc.min && wc.max, JSON.stringify(wc));
  check('close is ✕', wc.close === '✕', wc.close);

  // Demo sessions point at synthetic paths (/home/dev/code/…), so the terminal WS
  // can't spawn a PTY — those handshake failures are inherent to --demo, not a
  // regression. Everything else must be clean.
  const real = errors.filter((e) => !/WebSocket connection to .*\/ws\/term/.test(e));
  check('no console errors (demo PTY handshakes excluded)', real.length === 0, real.slice(0, 4).join(' | '));
} catch (e) {
  check('harness completed', false, String(e));
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
await browser.close();
srv.kill();
process.exit(pass === results.length ? 0 : 1);
