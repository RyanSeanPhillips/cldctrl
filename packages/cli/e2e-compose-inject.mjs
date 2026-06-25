// E2E smoke test: compose-box mechanics + #9 inject-into-running-session prefill.
// Drives a REAL cockpit tile but never submits to claude (compose test stops
// before send; inject uses autoSend:false → prefill only) so it can't pollute a
// real conversation.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 2620;
const CONTROL_DIR = path.join(process.env.APPDATA, 'cldctrl', 'control');
const INJECT_FILE = path.join(CONTROL_DIR, 'cockpit-inject.json');

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

  // Cockpit → Add picker → first resumable conversation as a real tile.
  await page.click('[data-act="view-cockpit"]');
  await page.waitForTimeout(400);
  await page.click('[data-act="cockpit-add-toggle"]');
  await page.waitForTimeout(600);
  const addRow = await page.$('[data-act="cockpit-add-resume"]');
  if (!addRow) { console.log('NO RESUMABLE SESSION FOUND — cannot run tile tests'); throw new Error('no resume row'); }
  const sessionId = await addRow.getAttribute('data-id');
  results['got sessionId'] = !!sessionId;
  await addRow.click();
  await page.waitForTimeout(5500); // xterm mount + WS connect + claude --resume

  const tile = await page.$('.tile[data-id^="resume:"]');
  results['tile mounted'] = !!tile;

  // ── compose-box mechanics (no submit) ──
  const composeBtn = await page.$('[data-act="tile-compose"]');
  results['compose toggle button present'] = !!composeBtn;
  // hidden by default
  results['compose bar hidden by default'] =
    await page.$eval('.tile-compose', (e) => getComputedStyle(e).display === 'none').catch(() => false);
  await composeBtn.click();
  await page.waitForTimeout(300);
  results['compose bar visible after toggle'] =
    await page.$eval('.tile-compose', (e) => getComputedStyle(e).display !== 'none').catch(() => false);
  results['textarea is spellcheck=true'] =
    await page.$eval('.compose-input', (e) => e.getAttribute('spellcheck') === 'true').catch(() => false);
  // type a multi-line message and confirm it populates + autosizes
  const ta = await page.$('.compose-input');
  const h0 = await ta.evaluate((e) => e.offsetHeight);
  await ta.click();
  await page.keyboard.type('line one of a composed message');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
  await page.keyboard.type('line two — Shift+Enter kept the newline');
  await page.waitForTimeout(200);
  const val = await ta.evaluate((e) => e.value);
  results['textarea holds typed multi-line text'] = val.includes('line one') && val.includes('line two') && val.includes('\n');
  // grow it further with several more lines to prove autosize tracks content
  for (let i = 0; i < 4; i++) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); await page.keyboard.type('more line ' + i); }
  await page.waitForTimeout(200);
  const h1 = await ta.evaluate((e) => e.offsetHeight);
  console.log('autosize debug — empty h0:', h0, '6-line h1:', h1);
  results['textarea auto-grew with content'] = h1 > h0;
  results['empty compose box is compact (<=40px)'] = h0 <= 40;
  // Escape closes the bar
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  results['Escape closes compose bar'] =
    await page.$eval('.tile-compose', (e) => getComputedStyle(e).display === 'none').catch(() => false);

  // ── #9 inject prefill (autoSend:false → no submit) ──
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  const injectMsg = 'INJECT-TEST-' + PORT + ': please confirm you received this';
  fs.writeFileSync(INJECT_FILE, JSON.stringify([{ sessionId, text: injectMsg, autoSend: false, note: 'e2e', ts: Date.now() }]), 'utf-8');
  // poll is 3s; give it two cycles
  await page.waitForTimeout(7000);
  const prefilled = await page.$eval('.tile[data-id^="resume:"] .compose-input', (e) => e.value).catch(() => '');
  results['inject prefilled the compose-box'] = prefilled.includes('INJECT-TEST-' + PORT);
  results['inject revealed the compose bar'] =
    await page.$eval('.tile[data-id^="resume:"] .tile-compose', (e) => getComputedStyle(e).display !== 'none').catch(() => false);
  // the prefilled text must NOT have been auto-sent (still in the box)
  results['inject did NOT auto-send (text retained)'] = prefilled.includes('INJECT-TEST-' + PORT);

  await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-compose-inject.png', fullPage: false });
} catch (err) {
  console.log('ERROR during test:', String(err));
} finally {
  // clean the bridge file so it can't leak into the user's real dashboard
  try { fs.rmSync(INJECT_FILE, { force: true }); } catch {}
}

console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(results)) console.log(ok(v).padEnd(5), k);
console.log('\nconsole errors:', errors.length ? errors.slice(0, 8) : 'none');

await browser.close();
srv.kill();
