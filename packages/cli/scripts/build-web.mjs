// Bundles the browser dashboard (src/web/main.ts + app.css) into dist/web/.
// Runs as tsup's onSuccess step. esbuild is already a transitive dep of tsup.
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// The web sources import with explicit `.js` specifiers (NodeNext-friendly for
// tsc), but the files on disk are `.ts`. Rewrite those specifiers for esbuild.
const jsToTs = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.')) return;
      const tsPath = path.resolve(path.dirname(args.importer), args.path.replace(/\.js$/, '.ts'));
      if (fs.existsSync(tsPath)) return { path: tsPath };
      return undefined;
    });
  },
};

await build({
  entryPoints: [path.join(root, 'src/web/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: path.join(root, 'dist/web/app.js'),
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  loader: { '.css': 'css' },
  plugins: [jsToTs],
  logLevel: 'info',
});

console.log('[build-web] dist/web/app.js + app.css written');

// ── build manifest ───────────────────────────────────────────
// A content hash of everything that affects runtime behaviour (server chunks +
// the web bundle/CSS, excluding sourcemaps and the manifest itself). The running
// server reads this at startup and re-reads it periodically; a changed buildId
// means a NEW build has landed on disk → the dashboard shows "restart to load".
// Written LAST and renamed atomically so a mid-build read never sees a partial
// manifest (and thus never announces an update before it's actually launchable).
const distDir = path.join(root, 'dist');

function hashDist(dir) {
  const hash = crypto.createHash('sha256');
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      // Only runtime-affecting artifacts: JS + CSS. Skip sourcemaps and the
      // manifest we're about to write.
      if (!/\.(js|css)$/.test(name)) continue;
      files.push(full);
    }
  };
  walk(dir);
  for (const f of files.sort()) {
    hash.update(path.relative(dir, f).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

let version = '0.0.0';
try {
  const consts = fs.readFileSync(path.join(root, 'src/constants.ts'), 'utf-8');
  version = consts.match(/export const VERSION = ['"]([^'"]+)['"]/)?.[1] ?? version;
} catch { /* keep default */ }

const manifest = { version, buildId: hashDist(distDir), builtAt: new Date().toISOString() };
const tmp = path.join(distDir, 'build-manifest.json.tmp');
const dest = path.join(distDir, 'build-manifest.json');
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
fs.renameSync(tmp, dest); // atomic — readers see the old or new file, never partial
console.log(`[build-web] build-manifest.json written (buildId ${manifest.buildId})`);
