// Verify the notepad-layout rework:
//  (1) ONE full-width toolbar spans the whole tile (window controls are NOT
//      stranded mid-tile when the notepad is open),
//  (2) the notepad has its own recessed SUBHEADER,
//  (3) the pencil (edit/preview) button is gone,
//  (4) opening the notepad injects NOTHING into the conversation.
// DEMO mode — no real agents spawned.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2742;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Open one conversation as a tile.
  await page.click('.side-conv[data-act="openincockpit"] >> nth=0');
  await page.waitForTimeout(900);
  const id = (await page.$$eval('.tile', (e) => e.map((x) => x.dataset.id)))[0];
  check('a tile mounted', !!id, id);

  // (1) header is a DIRECT child of .tile (full-width toolbar), not nested in .tile-conv
  const headParent = await page.$eval(`.tile[data-id="${id}"] > .tile-head`, () => 'direct').catch(() => 'nested');
  check('toolbar is a direct child of .tile (full width)', headParent === 'direct');
  const convHasHead = await page.$$eval(`.tile[data-id="${id}"] .tile-conv > .tile-head`, (e) => e.length).catch(() => 0);
  check('.tile-conv no longer holds a header', convHasHead === 0);

  // Open the notepad via the drawer rail.
  await page.click(`.tile[data-id="${id}"] [data-note="collapse"]`);
  await page.waitForTimeout(700);
  const noteOpen = await page.$eval(`.tile[data-id="${id}"] .tile-note`, (e) => !e.classList.contains('collapsed'));
  check('notepad opened', noteOpen);

  // (2) subheader exists and is shorter than the toolbar
  const geom = await page.evaluate((tid) => {
    const tile = document.querySelector(`.tile[data-id="${tid}"]`);
    const head = tile.querySelector(':scope > .tile-head');
    const nh = tile.querySelector('.note-head');
    const wc = tile.querySelector('.tile-wc');
    const hr = head.getBoundingClientRect(), nr = nh.getBoundingClientRect(), tr = tile.getBoundingClientRect(), wr = wc.getBoundingClientRect();
    return {
      headFull: Math.abs(hr.width - tr.width) < 2,             // toolbar spans the tile
      headH: Math.round(hr.height), noteH: Math.round(nr.height),
      wcRightAligned: (hr.right - wr.right) < 16,              // controls hug the toolbar's right (past its padding)
      noteBelowHead: nr.top >= hr.bottom - 1,                  // subheader sits under the toolbar
    };
  }, id);
  check('toolbar spans the full tile width', geom.headFull, `head=${geom.headH}px`);
  check('window controls sit at the tile far-right', geom.wcRightAligned);
  check('notepad subheader is under the toolbar', geom.noteBelowHead);
  check('subheader is shorter than the toolbar', geom.noteH < geom.headH, `${geom.noteH} < ${geom.headH}`);

  // (3) no pencil / mode button in the notepad
  const pencils = await page.$$eval(`.tile[data-id="${id}"] [data-note="mode"]`, (e) => e.length);
  check('notepad pencil (edit/preview) button removed', pencils === 0);

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-notepad-subheader.png' });

  // (4) no injected prompt: type in the notepad, confirm the terminal got no "(cldctrl)" FYI line
  await page.click(`.tile[data-id="${id}"] .note-edit`);
  await page.type(`.tile[data-id="${id}"] .note-edit`, 'draft text here', { delay: 8 });
  await page.waitForTimeout(700);
  const termText = await page.$eval(`.tile[data-id="${id}"] .tile-term`, (e) => e.innerText);
  check('opening/typing the notepad injects NO prompt into the chat', !/linked a notepad|scratchpad file at/i.test(termText));

  // Demo mode serves no real PTY, so resume tiles fail the /ws/term handshake —
  // expected noise, not a regression. Only fail on OTHER console errors.
  const realErrors = errors.filter((e) => !/ws\/term|handshake|Connection closed before receiving/i.test(e));
  check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));
} catch (e) {
  check('script ran without throwing', false, String(e));
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await browser.close();
  try { srv.kill(); } catch {}
  process.exit(passed === results.length ? 0 : 1);
}
