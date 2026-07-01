// Regenerate cldctrl.ico from the canonical brand mark (assets/brand.svg).
// Run when the branding changes:  node scripts/gen-icons.mjs
// (needs playwright-core + a Chromium at $CHROME to rasterize the SVG.)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.dirname(dir); // packages/cli
const svg = fs.readFileSync(path.join(pkg, 'assets', 'brand.svg'), 'utf-8')
  .replace(/<!--[\s\S]*?-->/g, '').trim();
const SIZES = [16, 32, 48, 64, 128, 256];   // packed into the .ico
const PNG_SIZES = [192, 512];               // standalone PNGs for the web manifest

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const render = async (size) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>*{margin:0;padding:0}svg{display:block}</style>${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}`);
  const buf = await page.screenshot({ omitBackground: true }); // transparent outside the tile
  await page.close();
  return buf;
};
const pngs = [];
for (const size of SIZES) pngs.push({ size, png: await render(size) });
for (const size of PNG_SIZES) {
  fs.writeFileSync(path.join(pkg, 'assets', `icon-${size}.png`), await render(size));
}
await browser.close();
console.log(`Wrote assets/icon-192.png + icon-512.png (manifest icons).`);

// Pack the PNGs into a multi-resolution .ico (PNG-compressed entries).
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
const table = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
for (let i = 0; i < count; i++) {
  const { size, png } = pngs[i];
  const e = i * 16;
  table.writeUInt8(size >= 256 ? 0 : size, e);      // width (0 = 256)
  table.writeUInt8(size >= 256 ? 0 : size, e + 1);  // height
  table.writeUInt16LE(1, e + 4);                    // color planes
  table.writeUInt16LE(32, e + 6);                   // bits per pixel
  table.writeUInt32LE(png.length, e + 8);           // image size
  table.writeUInt32LE(offset, e + 12);              // offset
  offset += png.length;
}
const ico = Buffer.concat([header, table, ...pngs.map((p) => p.png)]);
const out = path.join(pkg, 'cldctrl.ico');
fs.writeFileSync(out, ico);
console.log(`Wrote ${out} — ${count} sizes (${SIZES.join('/')}), ${ico.length} bytes.`);
