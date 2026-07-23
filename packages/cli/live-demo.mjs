import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const PORT = 2650;
const srv = spawn(process.execPath, ['dist/index.js','serve','--port',String(PORT),'--demo'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: false, args: ['--window-size=1520,1000'] });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
await page.addInitScript(() => localStorage.setItem('cldctrl-theme','midnight'));
await page.goto('http://127.0.0.1:'+PORT, { waitUntil: 'domcontentloaded' });
console.log('Live window open on port '+PORT+' (dark, full-height). Close it to end.');
await new Promise((resolve) => { browser.on('disconnected', resolve); setTimeout(resolve, 45*60_000); });
try { await browser.close(); } catch {}
srv.kill();
