// E2E: Codex search results render with a vendor chip and NO broken Claude
// resume button (the guard), while Claude results keep their resume actions.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 2623;
const ok = (b) => (b ? 'PASS' : 'FAIL');
const results = {};
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.fill('#search-input', 'session_index rollout codex');
  await page.waitForTimeout(1400);
  await page.waitForSelector('.search-res', { timeout: 8000 });

  const codexChips = await page.$$eval('.vendor-chip.codex', (e) => e.length);
  results['codex vendor chip rendered'] = codexChips > 0;
  const codexNotes = await page.$$eval('.res-note', (e) => e.length);
  results['codex rows show "found in Codex" note'] = codexNotes > 0;
  // a row that has a vendor chip should NOT also have a cockpit-resume button
  const brokenCodex = await page.$$eval('.search-res', (rows) =>
    rows.filter((r) => r.querySelector('.vendor-chip.codex') && r.querySelector('[data-act="openincockpit"]')).length);
  results['codex rows have NO claude resume button'] = brokenCodex === 0;
  // claude rows (no codex chip) should still have resume actions
  const claudeWithResume = await page.$$eval('.search-res', (rows) =>
    rows.filter((r) => !r.querySelector('.vendor-chip.codex') && r.querySelector('[data-act="openincockpit"]')).length);
  results['claude rows still have resume button'] = claudeWithResume > 0;

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-codex-ui.png', fullPage: false });
} catch (err) { console.log('ERROR:', String(err)); }

console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(results)) console.log(ok(v).padEnd(5), k);
console.log('\nconsole errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
srv.kill();
