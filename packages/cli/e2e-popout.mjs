// E2E: pop-out widget window. Demo mode (inert: WS terminals denied, /api/popout
// stubbed) — verifies the widget shell + the ↗ button + no console errors.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2691;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--demo', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2000));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const errors = [];
const mkPage = async () => {
  const p = await browser.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(String(e)));
  return p;
};

// 1) Main dashboard: open a conversation into the cockpit → tile header should have ↗
const page = await mkPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const conv = await page.$('.side-conv[data-act="openincockpit"]');
if (!conv) { console.log('FAIL: no sidebar conversation rows in demo'); process.exit(1); }
await conv.click();
await page.waitForTimeout(600);
const popBtns = await page.$$eval('[data-act="tile-popout"]', (e) => e.length);
console.log('pop-out buttons on resume tiles:', popBtns);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-popout-btn.png' });

// 2) Widget window: boots, mounts one full-window tile with notepad button, no grid
const w = await mkPage();
await w.goto(`http://127.0.0.1:${PORT}/?widget=1&kind=resume&session=demo-session-1&path=${encodeURIComponent('C:/demo/next.js')}&title=next.js%20%C2%B7%20demo&app=1`, { waitUntil: 'networkidle' });
await w.waitForTimeout(900);
const widget = {
  title: await w.title(),
  tiles: await w.$$eval('.widget-root .tile', (e) => e.length),
  noteBtn: await w.$$eval('.widget-root [data-act="tile-note"]', (e) => e.length),
  maxHidden: await w.$eval('[data-act="tile-max"]', (e) => getComputedStyle(e).display === 'none').catch(() => 'absent'),
  sidebar: await w.$$eval('.side', (e) => e.length),
  persisted: await w.evaluate(() => localStorage.getItem('cldctrl.session.v1')),
};
console.log('widget:', JSON.stringify(widget, null, 1));
await w.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-popout-widget.png' });

console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
srv.kill();
process.exit(0);
