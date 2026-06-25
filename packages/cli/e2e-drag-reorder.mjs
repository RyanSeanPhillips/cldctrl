// E2E smoke test: drag-to-reorder cockpit tiles WITHOUT tearing down PTYs.
// Uses one real terminal tile + one doc tile so we can prove the live PTY tile
// survives a reorder (its socket stays 'live', xterm content preserved).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2621;
const ok = (b) => (b ? 'PASS' : 'FAIL');
const results = {};

const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2200));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.click('[data-act="view-cockpit"]');
  await page.waitForTimeout(400);

  // 1) add a real terminal tile (resume the first active session)
  await page.click('[data-act="cockpit-add-toggle"]');
  await page.waitForTimeout(600);
  const addRow = await page.$('[data-act="cockpit-add-resume"]');
  if (!addRow) { console.log('NO RESUMABLE SESSION — cannot test PTY survival'); throw new Error('no resume row'); }
  await addRow.click();
  await page.waitForTimeout(5500); // PTY connect

  // 2) add a doc tile (a project CLAUDE.md) so we have two tiles to reorder
  await page.click('[data-act="cockpit-add-toggle"]');
  await page.waitForTimeout(500);
  await page.fill('#cockpit-doc-path', 'CLAUDE.md');
  await page.click('[data-act="cockpit-add-doc"]');
  await page.waitForTimeout(1500);

  const order0 = await page.$$eval('.cockpit-grid .tile', (els) => els.map((e) => e.dataset.id));
  results['two tiles present'] = order0.length === 2;
  const termId = order0.find((id) => id.startsWith('resume:'));
  results['terminal tile present'] = !!termId;

  // PTY tile state before reorder: status text + xterm rendered rows
  const before = await page.evaluate((id) => {
    const e = [...document.querySelectorAll('.tile')].find((t) => t.dataset.id === id);
    return { status: e?.querySelector('.tile-status')?.textContent || '', rows: e?.querySelectorAll('.xterm-rows > div').length || 0 };
  }, termId);
  results['terminal is live before reorder'] = before.status.includes('live');
  results['terminal has xterm content before'] = before.rows > 0;

  // 3) drag the SECOND tile's grip onto the FIRST tile's left half → it should move to front.
  await page.evaluate((ids) => {
    const tiles = [...document.querySelectorAll('.cockpit-grid .tile')];
    const second = tiles.find((t) => t.dataset.id === ids[1]);
    const first = tiles.find((t) => t.dataset.id === ids[0]);
    const grip = second.querySelector('.tile-grip');
    const dt = new DataTransfer();
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = first.getBoundingClientRect();
    const opts = { bubbles: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 10 };
    first.dispatchEvent(new DragEvent('dragover', opts));
    first.dispatchEvent(new DragEvent('drop', opts));
    grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, order0);
  await page.waitForTimeout(600);

  const order1 = await page.$$eval('.cockpit-grid .tile', (els) => els.map((e) => e.dataset.id));
  results['order changed (2nd tile moved to front)'] = order1[0] === order0[1] && order1[1] === order0[0];

  // PTY tile state AFTER reorder: must still be live + content preserved (not recreated)
  const after = await page.evaluate((id) => {
    const e = [...document.querySelectorAll('.tile')].find((t) => t.dataset.id === id);
    return { present: !!e, status: e?.querySelector('.tile-status')?.textContent || '', rows: e?.querySelectorAll('.xterm-rows > div').length || 0 };
  }, termId);
  results['terminal tile still present after reorder'] = after.present;
  results['terminal STILL live after reorder (PTY survived)'] = after.status.includes('live');
  results['terminal xterm content preserved'] = after.rows > 0;

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-drag-reorder.png', fullPage: false });
} catch (err) {
  console.log('ERROR during test:', String(err));
}

console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(results)) console.log(ok(v).padEnd(5), k);
console.log('\nconsole errors:', errors.length ? errors.slice(0, 8) : 'none');

await browser.close();
srv.kill();
