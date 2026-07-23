import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2619;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1800));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
await page.waitForSelector('.topbar', { timeout: 10000 });
await page.waitForTimeout(1000);

// Cockpit tab
await page.click('[data-act="view-cockpit"]');
await page.waitForTimeout(500);

// Open the Add picker and screenshot it
await page.click('[data-act="cockpit-add-toggle"]');
await page.waitForTimeout(500);
const pickerVisible = await page.$$eval('.cp-add', (e) => e.length);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/cockpit-add.png', fullPage: false });

// Add the first available conversation as a resume tile
const addRow = await page.$('[data-act="cockpit-add-resume"]');
let tileScratchPresent = false, docTilePresent = false;
if (addRow) {
  await addRow.click();
  await page.waitForTimeout(4500); // xterm mount + WS connect
  tileScratchPresent = (await page.$$eval('[data-act="tile-scratch"]', (e) => e.length)) > 0;
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/cockpit-tile.png', fullPage: false });

  // Click the scratchpad button → doc tile should appear beside the chat
  const scratchBtn = await page.$('[data-act="tile-scratch"]');
  if (scratchBtn) {
    await scratchBtn.click();
    await page.waitForTimeout(2500);
    docTilePresent = (await page.$$eval('.doc-tile', (e) => e.length)) > 0;
    await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/cockpit-scratch.png', fullPage: false });
  }
}

// Midnight theme on the dashboard
await page.click('[data-act="home"]');
await page.waitForTimeout(400);
await page.click('[data-act="theme"][data-theme="midnight"]');
await page.waitForTimeout(500);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/theme-midnight.png', fullPage: true });

console.log('picker visible:', pickerVisible > 0);
console.log('tile scratch button present:', tileScratchPresent);
console.log('doc tile appeared after scratch click:', docTilePresent);
console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');

await browser.close();
srv.kill();
