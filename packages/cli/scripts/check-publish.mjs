// Publish gate: fail the publish if the build didn't emit everything the
// package ships. Guards against a broken tsup onSuccess (the web bundle is
// built by a hook, not the main pipeline) shipping a dashboard-less release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const required = [
  'dist/index.js',
  'dist/mcp-server.js',
  'dist/web/app.js',
  'dist/web/app.css',
  'cldctrl.ico',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'hotkey.ps1',
  'desktop-probe.ps1',
];
const missing = required.filter((f) => !fs.existsSync(path.join(pkg, f)));
if (missing.length) {
  console.error('✗ publish blocked — missing build artifacts:\n  ' + missing.join('\n  '));
  process.exit(1);
}

// Version-sync gate: constants.ts VERSION is hardcoded (rootDir blocks a
// package.json import) and silently drifted 0.3.7 → 0.4.x once already. It
// feeds the dashboard sidebar, TUI welcome, and the update-available check.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
const constants = fs.readFileSync(path.join(pkg, 'src', 'constants.ts'), 'utf8');
const m = constants.match(/export const VERSION = '([^']+)'/);
if (!m || m[1] !== pkgVersion) {
  console.error(`✗ publish blocked — src/constants.ts VERSION ('${m?.[1] ?? '?'}') != package.json version ('${pkgVersion}')`);
  process.exit(1);
}
console.log('✓ publish check: all shipped artifacts present, VERSION in sync (' + pkgVersion + ')');
