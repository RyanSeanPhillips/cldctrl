// PROTOTYPE helper — screenshots the restore-UI prototype's three variants.
import { chromium } from 'playwright-core';

const URL = 'file:///C:/Users/rphil2/Dropbox/CLDCTRL/packages/cli/prototype-restore-ui.html';
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

for (const v of ['A', 'B', 'C']) {
  await page.goto(URL + '?variant=' + v);
  await page.waitForTimeout(400);
  const pk = await page.$('[data-peek="c2"]'); // expand one card's last-prompts peek
  if (pk) { await pk.click(); await page.waitForTimeout(200); }
  await page.screenshot({ path: `C:/Users/rphil2/Dropbox/CLDCTRL/proto-restore-${v}.png` });
}
// banner-only view (modal dismissed)
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/proto-restore-banner.png' });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
