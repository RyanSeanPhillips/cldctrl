// E2E: restore-workspace banner + spatial chooser (stale reopen path).
// Boots the BUILT server against an isolated config dir on a test port,
// seeds localStorage with a stale persisted session + pop-out registry,
// and drives banner → chooser → drag/checkbox → restore.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 2622;
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cldctrl-e2e-restore-'));
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], {
  stdio: 'ignore',
  env: { ...process.env, CLDCTRL_CONFIG_DIR: cfgDir },
});
await new Promise((r) => setTimeout(r, 1800));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); };

await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });

// Seed: stale session (1h old) with 2 grid tiles; registry with 1 orphan
// (died with the app) + 1 deliberate close (hours before shutdown → pruned).
await page.evaluate(() => {
  const ts = Date.now() - 60 * 60_000;
  const tile = (n) => ({ id: 'resume:sess-' + n, kind: 'resume', sessionId: 'sess-' + n, projectPath: 'C:/fake/proj-' + n, title: 'Conversation ' + n });
  localStorage.setItem('cldctrl.session.v1', JSON.stringify({
    ts,
    cockpit: { tiles: [tile('aaa111'), tile('bbb222')], layout: 'cols2', open: true, maximized: null, hiddenProjects: [] },
    sidebarCollapsed: false, collapsedGroups: [],
  }));
  localStorage.setItem('cldctrl.popouts.v1', JSON.stringify({
    'resume:sess-win111': { tile: { ...tile('win111'), title: 'Popped-out conversation' }, lastSeen: ts - 60_000 },
    'resume:sess-old999': { tile: { ...tile('old999'), title: 'Closed at 9am' }, lastSeen: ts - 5 * 3600_000 },
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// 1. Banner offers grid tiles + the orphan pop-out (3), and pruned the deliberate close.
const bannerText = await page.$eval('.restore-banner', (e) => e.textContent).catch(() => null);
check('banner appears with 3 conversations', !!bannerText && bannerText.includes('3 conversation'), String(bannerText).slice(0, 90));
const popoutsAfterBoot = await page.evaluate(() => JSON.parse(localStorage.getItem('cldctrl.popouts.v1') || '{}'));
check('deliberate close pruned, orphan kept',
  !popoutsAfterBoot['resume:sess-old999'] && !!popoutsAfterBoot['resume:sess-win111'], Object.keys(popoutsAfterBoot).join(','));
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-restore-banner.png' });

// 2. Choose… opens the chooser with 2 cockpit cards + 1 window card.
await page.click('[data-act="restore-choose"]');
await page.waitForTimeout(400);
const counts = async () => ({
  grid: (await page.$$('.rst-zone-grid .rst-card')).length,
  win: (await page.$$('.rst-zone-win .rst-card')).length,
  skip: (await page.$$('.rst-zone-skip .rst-card')).length,
});
let c = await counts();
check('chooser zones 2/1/0', c.grid === 2 && c.win === 1 && c.skip === 0, JSON.stringify(c));
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-restore-chooser.png' });

// 3. Drag a cockpit card into the skip zone (synthetic DnD — delegated handlers).
await page.evaluate(() => {
  const card = document.querySelector('.rst-zone-grid .rst-card');
  const zone = document.querySelector('[data-rzone="skip"]');
  const dt = new DataTransfer();
  card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(300);
c = await counts();
check('drag grid→skip moves the card (1/1/1)', c.grid === 1 && c.win === 1 && c.skip === 1, JSON.stringify(c));

// 4. Re-check its checkbox → returns to its origin zone.
await page.click('.rst-zone-skip .rst-card input[data-act="restore-ck"]');
await page.waitForTimeout(300);
c = await counts();
check('re-check returns card to cockpit (2/1/0)', c.grid === 2 && c.win === 1 && c.skip === 0, JSON.stringify(c));

// 5. Uncheck the window card (avoid spawning a real chromeless window in CI),
//    then Restore: 2 grid tiles mount, offer closes, registry fully cleaned.
await page.click('.rst-zone-win .rst-card input[data-act="restore-ck"]');
await page.waitForTimeout(300);
await page.click('[data-act="restore-apply"]');
await page.waitForTimeout(2500);
const modalGone = (await page.$$('.rst-back')).length === 0;
const bannerGone = (await page.$$('.restore-banner')).length === 0;
const tiles = (await page.$$('.tile-head')).length;
const popoutsAfterApply = await page.evaluate(() => JSON.parse(localStorage.getItem('cldctrl.popouts.v1') || '{}'));
check('restore applies: modal+banner gone, 2 tiles, registry empty',
  modalGone && bannerGone && tiles === 2 && Object.keys(popoutsAfterApply).length === 0,
  `modalGone=${modalGone} bannerGone=${bannerGone} tiles=${tiles} reg=${Object.keys(popoutsAfterApply).length}`);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-restore-applied.png' });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (errors.length) console.log('console errors:', errors.slice(0, 8));
await browser.close();
srv.kill();
process.exit(failed ? 1 : 0);
