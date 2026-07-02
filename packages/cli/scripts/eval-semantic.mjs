#!/usr/bin/env node
/**
 * Eval harness for the Tier-0 semantic re-rank (core/semantic-rerank.ts).
 *
 * Runs realistic "fuzzy recall" queries against YOUR real conversation history
 * and prints keyword ranking vs semantic re-rank side by side, so the lift (or
 * lack of it) is measurable before anyone trusts the feature.
 *
 * Usage (from packages/cli):
 *   node scripts/eval-semantic.mjs                 # built-in query set
 *   node scripts/eval-semantic.mjs "your query"    # ad-hoc query
 *
 * Requirements: an embedder install (`npm i --no-save @huggingface/transformers`
 * or a global install). First run downloads the ~23MB MiniLM model to
 * <configDir>/models; later runs are offline and served from semantic-cache.json.
 *
 * The script bundles the TS sources on the fly with esbuild (already present as
 * a tsup dependency), so it needs no build step and exports nothing new from dist.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(pkgDir);

// ── Bundle the module under test (kept inside node_modules so the external
//    transformers import still resolves from the bundle's location) ──────────
const { build } = await import('esbuild');
const outDir = path.join(pkgDir, 'node_modules', '.cldctrl-eval');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'semantic-rerank.bundle.mjs');
await build({
  entryPoints: [path.join(pkgDir, 'src', 'core', 'semantic-rerank.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile,
  external: ['@huggingface/transformers', '@xenova/transformers', 'node-pty', 'ws', 'react', 'ink'],
  banner: { js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);` },
  logLevel: 'silent',
});
const mod = await import(pathToFileURL(outfile).href);
const { searchConversationsSmart, semanticSearchEnabled } = mod;

// ── Query set: conceptual/fuzzy recall — the case keyword ranking is weak at ─
const QUERIES = process.argv[2]
  ? [process.argv[2]]
  : [
      'what did we decide about the idle threshold for sessions',
      'why did the titlebar look black on light themes',
      'fixing flicker when the terminal redraws frames',
      'detecting conversations that were started outside cldctrl',
      'usage percentage stopped showing because auth headers changed',
      'making the dashboard feel like a real desktop app instead of a browser tab',
    ];

const TOP = 8;
const fmt = (r) => `${(r.project || '?').slice(0, 22).padEnd(22)} ${r.date.slice(0, 10)} [${r.vendor}] ${r.snippet.replace(/\s+/g, ' ').slice(0, 70)}`;

console.log('Semantic re-rank eval — keyword vs keyword+semantic');
console.log('====================================================\n');

for (const q of QUERIES) {
  console.log(`◆ QUERY: "${q}"`);

  process.env.CLDCTRL_SEMANTIC = '0';
  const t0 = Date.now();
  const kw = await searchConversationsSmart(q, TOP);
  const kwMs = Date.now() - t0;

  process.env.CLDCTRL_SEMANTIC = '1';
  const t1 = Date.now();
  const sem = await searchConversationsSmart(q, TOP);
  const semMs = Date.now() - t1;

  if (!kw.results.length) { console.log('  (no keyword matches — nothing to re-rank)\n'); continue; }
  if (!sem.semantic) console.log('  ⚠ semantic re-rank did NOT run (embedder unavailable/timed out) — both columns are keyword order');

  const kwIds = kw.results.map((r) => r.sessionId);
  console.log(`  keyword ${kwMs}ms | semantic ${semMs}ms`);
  console.log(`  ${'—'.repeat(100)}`);
  for (let i = 0; i < Math.max(kw.results.length, sem.results.length); i++) {
    const a = kw.results[i], b = sem.results[i];
    const moved = b ? (() => { const was = kwIds.indexOf(b.sessionId); return was < 0 ? ' NEW' : was === i ? '  = ' : ` ${was > i ? '↑' : '↓'}${Math.abs(was - i)} `; })() : '';
    console.log(`  KW #${i + 1} ${a ? fmt(a) : ''}`);
    console.log(`  SM #${i + 1}${moved}${b ? fmt(b) : ''}`);
  }
  console.log('');
}

console.log(`(flag check: semanticSearchEnabled() with env unset would be ${(delete process.env.CLDCTRL_SEMANTIC, semanticSearchEnabled())} from config)`);
