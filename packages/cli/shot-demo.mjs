// Screenshot the `cc serve --demo` dashboard (synthetic OSS-repo data). Boots
// the REAL built server in demo mode; no Claude session, no real projects.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const PORT = 2631;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT), '--demo'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
try {
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-demo-dashboard.png' });
  const projects = await page.$$eval('.proj-row', (els) => els.length).catch(() => 0);
  const live = await page.$eval('.live-count', (e) => e.textContent).catch(() => '');
  console.log('projects rendered:', projects, '| live-count:', JSON.stringify(live));
  console.log('console errors:', errs.length, errs.slice(0, 3));
} catch (e) { console.log('ERR', String(e)); }
await browser.close(); srv.kill();
