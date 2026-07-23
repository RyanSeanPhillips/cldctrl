// Narrow-pane header behaviour + the conversation/notepad header alignment.
//
// REGRESSION: .tile-head used flex-wrap:wrap so a cramped header (notepad docked
// in a 2-up grid) broke into TWO ragged rows — which also made it taller than the
// notepad's header beside it, so the two strips visibly failed to line up.
// Now: both headers are pinned to one shared height, never wrap, and shed
// low-value text via container queries keyed to their OWN pane width.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2743;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 880 } })).newPage();
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : '')); };

// Header geometry for the first tile: are the two strips the same height and top?
const heads = () => page.evaluate(() => {
  const t = document.querySelector('.tile');
  const ch = t?.querySelector('.tile-head');
  const nh = t?.querySelector('.note-head');
  const noteEl = t?.querySelector('.tile-note');
  const noteVisible = !!noteEl && !noteEl.classList.contains('collapsed');
  const r = (e) => (e ? e.getBoundingClientRect() : null);
  const c = r(ch), n = noteVisible ? r(nh) : null;
  return {
    convH: c?.height ?? null, noteH: n?.height ?? null,
    convTop: c?.top ?? null, noteTop: n?.top ?? null,
    convPaneW: r(t?.querySelector('.tile-conv'))?.width ?? null,
    // does the header overflow its own pane horizontally?
    overflows: ch ? ch.scrollWidth > ch.clientWidth + 1 : null,
    wrapped: ch ? getComputedStyle(ch).flexWrap : null,
  };
});
const shown = (sel) => page.evaluate((s) => {
  const e = document.querySelector('.tile ' + s);
  return !!e && getComputedStyle(e).display !== 'none';
}, sel);

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.side-usage', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.click('.side-conv[data-act="openincockpit"] >> nth=0'); await page.waitForTimeout(600);
  await page.click('.side-conv[data-act="openincockpit"] >> nth=1'); await page.waitForTimeout(900);

  check('header never wraps', (await heads()).wrapped === 'nowrap', (await heads()).wrapped);

  // ── wide: everything on show ─────────────────────────────
  let h = await heads();
  check('wide pane keeps the status text', await shown('.tile-status'), 'pane ' + Math.round(h.convPaneW) + 'px');
  check('wide pane header does not overflow', h.overflows === false);

  // ── notepad docked: the cramped case the user hit ────────
  await page.click('.tile .note-rail');
  await page.waitForTimeout(900);
  h = await heads();
  check('notepad halves the pane', h.convPaneW < 400, Math.round(h.convPaneW) + 'px');
  check('both header strips are the SAME height', h.convH === h.noteH, `conv ${h.convH} vs note ${h.noteH}`);
  check('both header strips share a top edge', Math.abs(h.convTop - h.noteTop) < 0.5, `${h.convTop} vs ${h.noteTop}`);
  check('header still fits its pane (no clipped controls)', h.overflows === false);
  check('window controls all still visible', await page.evaluate(() => {
    const t = document.querySelector('.tile');
    return ['tile-min', 'tile-max', 'tile-close', 'tile-more']
      .every((a) => { const b = t.querySelector(`[data-act="${a}"]`); return b && b.getBoundingClientRect().width > 0; });
  }));
  check('low-value status text is shed when cramped', (await shown('.tile-status')) === false);

  // The notepad's own header got the same overflow treatment — four icon buttons
  // were eating half its width and crushing the note name to "no…".
  // Assert it isn't ELLIPSISED (a width threshold would just encode today's font
  // metrics; "notepad" at its natural width is the actual goal).
  const nameFits = await page.$eval('.tile .note-name-text',
    (e) => ({ fits: e.scrollWidth <= e.clientWidth + 1, text: e.textContent, w: Math.round(e.getBoundingClientRect().width) }));
  check('note name reads in full when cramped', nameFits.fits, `"${nameFits.text}" @ ${nameFits.w}px`);
  check('note header exposes a ⌄ overflow', await page.evaluate(() =>
    !!document.querySelector('.tile .note-head [data-act="tile-more"]')));
  await page.click('.tile .note-head [data-act="tile-more"]');
  await page.waitForTimeout(350);
  const noteRows = await page.$$eval('.tile:nth-of-type(1) .note-head .tile-menu .tile-mi', (e) => e.map((x) => x.textContent.trim()));
  check('note menu rows are labelled', noteRows.length === 3, noteRows.join(' | '));
  await page.mouse.click(5, 5); await page.waitForTimeout(250);

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-narrow-heads.png' });

  // ── splitter: rebalance instead of being stuck at 50/50 ──
  check('splitter present on the notepad inner edge', await shown('.note-split'));
  const box = await page.$eval('.tile .note-split', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const before = (await heads()).convPaneW;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y, { steps: 12 }); // drag RIGHT → conversation grows
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = (await heads()).convPaneW;
  check('dragging the splitter rebalances the panes', after > before + 100, `${Math.round(before)}px → ${Math.round(after)}px`);
  check('headers stay aligned after a drag', await page.evaluate(async () => {
    const t = document.querySelector('.tile');
    const a = t.querySelector('.tile-head').getBoundingClientRect();
    const b = t.querySelector('.note-head').getBoundingClientRect();
    return a.height === b.height && Math.abs(a.top - b.top) < 0.5;
  }));

  await page.dblclick('.tile .note-split');
  await page.waitForTimeout(400);
  const reset = (await heads()).convPaneW;
  check('double-click restores an even split', Math.abs(reset - before) < 30, `${Math.round(reset)}px vs ${Math.round(before)}px`);

  // ── extreme: 3-up grid with the notepad open ─────────────
  await page.click('[data-act="cockpit-layout"][data-layout="grid"]').catch(() => {});
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(900);
  h = await heads();
  check('very narrow pane still fits its header', h.overflows === false, Math.round(h.convPaneW) + 'px');
  check('very narrow: headers still aligned', h.convH === h.noteH && Math.abs(h.convTop - h.noteTop) < 0.5, `${h.convH}/${h.noteH}`);
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-narrow-extreme.png' });
} catch (e) {
  check('harness completed', false, String(e));
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
await browser.close();
srv.kill();
process.exit(pass === results.length ? 0 : 1);
