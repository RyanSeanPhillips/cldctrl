// Launches `cc serve` + a VISIBLE Playwright browser on your screen and keeps
// both alive so you can click around. Ctrl+C (or closing the window) tears down.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 2617);
const URL = 'http://127.0.0.1:' + PORT;

const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1800));

const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  headless: false,
  args: ['--window-size=1340,960', '--window-position=80,40'],
});
const page = await browser.newPage({ viewport: null });
await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Dock starts collapsed (rail on the right) — click "Agent" to open it.
console.log('\n>>> Live dashboard open at ' + URL + ' — Ctrl+C here to close.\n');

const shutdown = async () => { try { await browser.close(); } catch {} try { srv.kill(); } catch {} process.exit(0); };
browser.on('disconnected', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await new Promise(() => {}); // keep process alive
