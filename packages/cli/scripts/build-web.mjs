// Bundles the browser dashboard (src/web/main.ts + app.css) into dist/web/.
// Runs as tsup's onSuccess step. esbuild is already a transitive dep of tsup.
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';

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
