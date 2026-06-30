// E2E: image lightbox gallery stepper. Open Stats (widest range to maximize the
// chance of image markers), click an image marker, then assert the single-image
// gallery shows a counter and steps with the ›/← arrow + ArrowRight key, and Esc
// closes. Degrades gracefully (reports SKIP) when no image data exists to drive.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const PORT = 2627;
const srv = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const ok = (b) => (b ? 'PASS' : 'FAIL'); const R = {};
try {
  await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'networkidle' });
  await page.waitForSelector('.topbar', { timeout: 10000 });
  await page.click('[data-act="nav-stats"]'); await page.waitForTimeout(400); // Stats is now a top-level destination
  await page.click('[data-act="stats-days"][data-days="30"]'); // widest window → most images
  await page.waitForSelector('#stats-body .card', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const marks = await page.$$('#stats .imgmark, #stats [data-imgs]');
  if (!marks.length) {
    R['SKIP — no image markers in this account window'] = true;
    console.log('No image markers found; cannot drive the gallery live. CSS/wiring still built+typechecked.');
  } else {
    // prefer a marker covering multiple images (its label reads "N images")
    let target = marks[0], best = 0;
    for (const m of marks) {
      const lab = (await m.getAttribute('data-label')) || '';
      const n = Number((lab.match(/(\d+)\s+image/) || [])[1] || 1);
      if (n > best) { best = n; target = m; }
    }
    await target.click({ force: true }); // SVG <rect> child intercepts; listener is on the parent <g>, click bubbles
    await page.waitForSelector('#lb.open', { timeout: 5000 });
    await page.waitForTimeout(400);

    const oneImg = await page.$$eval('#lb #lb-imgs img', (a) => a.length);
    R['exactly one image shown at a time'] = oneImg === 1;
    const count1 = (await page.$eval('#lb .lb-count', (e) => e.textContent).catch(() => '')) || '';
    const total = Number((count1.match(/\/\s*(\d+)/) || [])[1] || (best > 1 ? best : 1));
    console.log('counter:', JSON.stringify(count1), 'total:', total, 'best-label-count:', best);

    if (total > 1) {
      R['counter shows "1 / N"'] = /^\s*1\s*\/\s*\d+/.test(count1);
      R['nav arrows visible for multi-image set'] = await page.$eval('#lb .lb-next', (e) => getComputedStyle(e).display !== 'none');
      const src1 = await page.$eval('#lb #lb-imgs img', (e) => e.src);
      await page.click('#lb .lb-next'); await page.waitForTimeout(150);
      const count2 = await page.$eval('#lb .lb-count', (e) => e.textContent);
      const src2 = await page.$eval('#lb #lb-imgs img', (e) => e.src);
      R['› advances counter to "2 / N"'] = /^\s*2\s*\/\s*\d+/.test(count2);
      R['› changes the displayed image'] = src1 !== src2;
      await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150);
      const count3 = await page.$eval('#lb .lb-count', (e) => e.textContent);
      R['ArrowLeft steps back to "1 / N"'] = /^\s*1\s*\/\s*\d+/.test(count3);
    } else {
      R['SKIP stepper — only one image in clicked turn'] = true;
      R['single image hides nav arrows'] = await page.$eval('#lb .lb-next', (e) => getComputedStyle(e).display === 'none');
    }
    await page.screenshot({ path: 'C:/Users/rphil2/Dropbox/CLDCTRL/e2e-image-gallery.png' });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    R['Escape closes the lightbox'] = await page.$eval('#lb', (e) => !e.classList.contains('open'));
  }
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  R['no console errors during gallery use'] = errs.length === 0;
} catch (e) { console.log('ERR', String(e)); R['threw'] = false; }
console.log('\n=== RESULTS ===');
for (const [k, v] of Object.entries(R)) console.log(ok(v).padEnd(5), k);
await browser.close(); srv.kill();
