import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2617;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1800));

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
const notFound = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', async (r) => {
  if (r.status() === 404) {
    let body = ''; try { body = (await r.text()).slice(0, 80); } catch {}
    notFound.push(r.url().replace(/^https?:\/\/[^/]+/, '') + ' → ' + body);
  }
});

await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
await page.waitForSelector('.topbar', { timeout: 10000 });
await page.waitForTimeout(1200);

// 1) Dashboard
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/web-dashboard.png', fullPage: true });

const rows = await page.$$eval('.srow', (e) => e.length);
const projects = await page.$$eval('.proj-row', (e) => e.length);
const cols = await page.$$eval('.thead .th', (e) => e.map((x) => x.textContent.replace(/[↓↑\s]+$/, '')));

// 1b) Project detail: click a project → detail view with tabs
await page.click('.proj-list .proj-row');
await page.waitForSelector('.detail-card', { timeout: 5000 });
await page.waitForTimeout(1200);
const detailName = await page.$eval('.detail-name', (e) => e.textContent);
const tabs = await page.$$eval('.tabs .tab', (e) => e.map((x) => x.textContent.trim().replace(/\s+/g, ' ')));
const heatmaps = await page.$$eval('.detail-activity .heat', (e) => e.length);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/web-detail.png', fullPage: true });
const sessionTitles = await page.$$eval('.srow2 .drow-title', (e) => e.slice(0, 3).map((x) => x.textContent.slice(0, 70)));
// session drill-in: click a session row → transcript loads
await page.click('.srow2 .drow'); await page.waitForTimeout(1400);
const transcriptLines = await page.$$eval('.srow2.expanded .transcript > div', (e) => e.length);
// click Commits then Files tabs
await page.click('[data-tab="commits"]'); await page.waitForTimeout(900);
const commitRows = await page.$$eval('.drow', (e) => e.length);
await page.click('[data-tab="files"]'); await page.waitForTimeout(900);
const fileRows = await page.$$eval('.ft2-row', (e) => e.length);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/web-detail-files.png', fullPage: true });
// back to conversations
await page.click('[data-act="home"]'); await page.waitForTimeout(600);

// 1c) Conversation search
await page.fill('#search-input', 'dashboard');
await page.waitForTimeout(1400);
const searchResults = await page.$$eval('.search-res', (e) => e.length);
const firstSearchSnippet = await page.$eval('.search-res .drow-title', (e) => e.textContent.slice(0, 80)).catch(() => null);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/web-search.png', fullPage: true });
await page.click('[data-act="searchclear"]'); await page.waitForTimeout(400);

// 2) Open the agent dock (collapsed rail by default)
await page.click('.dock-rail');
await page.waitForTimeout(6500); // xterm mount + WS connect + control session stream

const dockOpen = await page.evaluate(() => document.getElementById('dock').classList.contains('open'));
const hasXterm = await page.$$eval('#dock-term .xterm', (e) => e.length);
const status = await page.evaluate(() => document.getElementById('dock-status').textContent);
await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/web-agent-shot.png', fullPage: false });

// 3) Persistence: close + reopen, confirm same session replays
await page.click('[data-act="dockClose"]');
await page.waitForTimeout(700);
await page.click('.dock-rail');
await page.waitForTimeout(2500);
const reopenStatus = await page.evaluate(() => document.getElementById('dock-status').textContent);
const replayedChars = await page.evaluate(() => {
  const r = document.querySelectorAll('#dock-term .xterm-rows > div');
  return Array.from(r).map((x) => x.textContent).join('').trim().length;
});

console.log('session rows:', rows, '| project rows:', projects);
console.log('table columns:', JSON.stringify(cols));
console.log('detail name:', JSON.stringify(detailName), '| tabs:', JSON.stringify(tabs), '| heatmaps:', heatmaps);
console.log('session titles (gist):', JSON.stringify(sessionTitles, null, 0));
console.log('session transcript lines:', transcriptLines);
console.log('search results for "dashboard":', searchResults, '| first snippet:', JSON.stringify(firstSearchSnippet));
console.log('commit rows:', commitRows, '| file rows:', fileRows);
console.log('dock open:', dockOpen, '| xterm mounted:', hasXterm > 0, '| status:', JSON.stringify(status));
console.log('after reopen — status:', JSON.stringify(reopenStatus), '| replayed chars:', replayedChars);
console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
console.log('404 urls:', notFound.length ? notFound : 'none');

await browser.close();
srv.kill();
