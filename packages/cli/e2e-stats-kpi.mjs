// E2E: Stats KPI cards must be readable on LIGHT themes (the --text-bright bug:
// values were white-on-white). Switch to daylight, open Stats, assert the KPI
// values are present AND a dark (visible) color.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const PORT = 2625;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const ok = (b) => (b ? 'PASS' : 'FAIL'); const R = {};
try {
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.click('[data-act="theme"][data-theme="daylight"]'); // the broken (light) case
  await page.waitForTimeout(300);
  await page.click('[data-act="view-cockpit"]'); await page.waitForTimeout(300);
  await page.click('[data-act="cockpit-tab"][data-tab="stats"]');
  await page.waitForSelector('#stats .kpi .v', { timeout: 10000 });
  await page.waitForTimeout(800);
  const kpis = await page.$$eval('#stats .kpi', (cards) => cards.map((c) => ({
    label: c.querySelector('.k')?.textContent || '',
    value: c.querySelector('.v')?.textContent || '',
    color: c.querySelector('.v') ? getComputedStyle(c.querySelector('.v')).color : '',
  })));
  R['kpi cards present'] = kpis.length > 0;
  R['all kpi values non-empty'] = kpis.every((c) => c.value.trim().length > 0);
  const isWhite = (c) => /rgb\(2(5[0-5]|4\d), 2(5[0-5]|4\d), 2(5[0-5]|4\d)\)/.test(c);
  R['kpi values dark/visible on light bg'] = kpis.every((c) => !isWhite(c.color));
  // also check the card <h2> titles + legend bold use a visible color now
  const h2color = await page.$eval('#stats .card h2', (e) => getComputedStyle(e).color).catch(() => '');
  R['card titles dark/visible on light bg'] = !!h2color && !isWhite(h2color);
  console.log('theme=daylight sample KPIs:', JSON.stringify(kpis.slice(0, 5)));
  console.log('card h2 color:', h2color);
  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-stats-kpi-light.png' });
} catch (e) { console.log('ERR', String(e)); }
console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(R)) console.log(ok(v).padEnd(5), k);
await browser.close(); srv.kill();
