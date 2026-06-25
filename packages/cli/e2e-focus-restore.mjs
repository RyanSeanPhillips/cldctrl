// Verifies the focus-restore logic added to syncCockpit() — WITHOUT touching any
// real sessions (no server, no claude --resume, no VS Code side effects).
// Builds a synthetic grid of tiles each with a compose <textarea>, focuses one,
// then replays the exact capture→insertBefore(move)→restore sequence syncCockpit
// now performs, and asserts focus + caret + value all survive the DOM move.
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage();
const R = {};
const ok = (b) => (b ? 'PASS' : 'FAIL');

await page.setContent(`<div id="cockpit-grid">
  <div class="tile" data-id="a"><textarea class="compose-input"></textarea></div>
  <div class="tile" data-id="b"><textarea class="compose-input"></textarea></div>
</div>`);

// Focus the SECOND tile's textarea, type, place caret mid-string.
await page.evaluate(() => {
  const ta = document.querySelectorAll('.tile[data-id="b"] .compose-input')[0];
  ta.focus();
  ta.value = 'half-written message';
  ta.setSelectionRange(4, 4); // caret after "half"
});

// 1) Baseline: a NAIVE move (no restore) blurs it — proves the bug exists.
R['naive insertBefore blurs (bug confirmed)'] = await page.evaluate(() => {
  const grid = document.getElementById('cockpit-grid');
  const tile = document.querySelector('.tile[data-id="b"]');
  const was = document.activeElement;
  grid.insertBefore(tile, grid.firstElementChild);
  const blurred = document.activeElement !== was;
  grid.appendChild(tile); // put it back for the next test
  return blurred;
});

// re-focus + re-set caret after the put-back
await page.evaluate(() => {
  const ta = document.querySelector('.tile[data-id="b"] .compose-input');
  ta.focus(); ta.setSelectionRange(4, 4);
});

// 2) The FIX: capture before, move, restore after — mirrors syncCockpit().
const after = await page.evaluate(() => {
  const grid = document.getElementById('cockpit-grid');
  // --- capture (start of syncCockpit) ---
  const ae = document.activeElement;
  const keepFocus = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && grid.contains(ae)
    ? { el: ae, start: ae.selectionStart, end: ae.selectionEnd } : null;
  // --- move (order enforcement) ---
  const tile = document.querySelector('.tile[data-id="b"]');
  grid.insertBefore(tile, grid.firstElementChild);
  // --- restore (end of syncCockpit) ---
  if (keepFocus && keepFocus.el.isConnected && document.activeElement !== keepFocus.el) {
    keepFocus.el.focus();
    try { keepFocus.el.setSelectionRange(keepFocus.start ?? 0, keepFocus.end ?? 0); } catch {}
  }
  const a = document.activeElement;
  return { focused: a && a.classList.contains('compose-input'), value: a?.value, caret: a?.selectionStart };
});

R['focus restored after move'] = after.focused === true;
R['value preserved'] = after.value === 'half-written message';
R['caret position preserved'] = after.caret === 4;

console.log('after-fix state:', JSON.stringify(after));
console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(R)) console.log(ok(v).padEnd(5), k);
await browser.close();
