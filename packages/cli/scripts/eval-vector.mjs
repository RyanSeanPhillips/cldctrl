#!/usr/bin/env node
/**
 * Eval harness for Tier-1 semantic search (core/vector-index.ts + the hybrid
 * in core/semantic-rerank.ts).
 *
 * The claim under test is RECALL: queries phrased by *meaning* (not the
 * target's literal vocabulary) should surface the right conversation. Because
 * keyword search is a ranked-OR over 40k-char docs it almost always "finds"
 * *something* — so the honest metric isn't "keyword found nothing", it's:
 * at what RANK does the correct conversation appear, keyword vs hybrid?
 *
 * Each built-in test pins the correct conversation by a doc SIGNATURE (a term
 * the target discussion provably contains — e.g. `speechSynthesis` for "reads
 * the text aloud") that the QUERY deliberately avoids. The harness reports the
 * first rank whose indexed doc matches the signature, plus any vector-only
 * results (sessions keyword missed entirely).
 *
 * Usage (from packages/cli):
 *   node scripts/eval-vector.mjs                 # full index build + built-in tests
 *   node scripts/eval-vector.mjs "your query"    # ad-hoc query (no signature scoring)
 *   node scripts/eval-vector.mjs --no-build ...  # skip the eager index build
 *
 * Requirements: an embedder install (`npm i --no-save @huggingface/transformers`
 * or a global install). First run downloads the ~23MB MiniLM model to
 * <configDir>/models and embeds the corpus once (progress is printed); later
 * runs are incremental and fast.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(pkgDir);

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const adhoc = args.filter((a) => !a.startsWith('--'));

// ── Bundle the modules under test (kept inside node_modules so the external
//    transformers import still resolves from the bundle's location) ──────────
const { build } = await import('esbuild');
const outDir = path.join(pkgDir, 'node_modules', '.cldctrl-eval');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'vector-eval.bundle.mjs');
await build({
  stdin: {
    contents:
      `export * from './src/core/semantic-rerank.ts';` +
      `export * from './src/core/vector-index.ts';` +
      `export { getSessionDoc } from './src/core/conversation-search.ts';`,
    resolveDir: pkgDir,
    loader: 'ts',
  },
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
const { searchConversationsSmart, buildVectorIndexFull, getSessionDoc } = mod;

// ── Phase 1: build/refresh the persistent index (incremental) ───────────────
if (!noBuild) {
  console.log('Building/refreshing the vector index (incremental — unchanged sessions are skipped)…');
  const t0 = Date.now();
  let batches = 0;
  const final = await buildVectorIndexFull({
    batch: 500,
    onProgress: (s) => {
      batches++;
      console.log(
        `  batch ${batches}: +${s.embeddedChunks} chunks embedded | index: ${s.sessions} sessions / ${s.totalChunks} chunks` +
        ` | pending: ${s.pendingSessions} sessions | dropped by caps: ${s.droppedSessions}`,
      );
    },
  });
  if (!final) {
    console.error('✖ Embedder unavailable — install @huggingface/transformers. Aborting eval.');
    process.exit(1);
  }
  console.log(`Index ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${final.sessions} sessions, ${final.totalChunks} chunks, complete=${final.complete}\n`);
}

// ── Phase 2: recall tests ────────────────────────────────────────────────────
// q avoids the target's vocabulary; `sig` is a term the target doc provably
// contains (verify against your corpus with a grep over search-index.json).
const TESTS = adhoc.length
  ? adhoc.map((q) => ({ q, sig: null, min: 1, proj: null }))
  : [
      { q: 'highlight each word while the computer reads the text aloud', sig: /speechsynthesis/i, min: 1, proj: null },
      { q: 'hand a task over to a different coding agent with a summary of the context', sig: /handoff/i, min: 3, proj: 'CLDCTRL' },
      { q: 'add google gemini as a third assistant next to claude and codex', sig: /antigravity/i, min: 2, proj: 'CLDCTRL' },
      { q: 'find past discussions by meaning rather than exact matching text', sig: /claude-mem/i, min: 2, proj: 'CLDCTRL' },
      { q: 'detach a conversation into its own separate little window', sig: /pop-?out/i, min: 3, proj: 'CLDCTRL' },
      { q: 'the screen flashes annoyingly every time it redraws', sig: /flicker/i, min: 2, proj: 'CLDCTRL' },
      { q: 'my usage meter is stuck showing the same number for hours', sig: /rate.?limit/i, min: 3, proj: 'CLDCTRL' },
    ];

const TOP = 20;   // ranks examined for the target
const SHOW = 5;   // rows printed per list
const fmt = (r) =>
  `${(r.project || '?').slice(0, 20).padEnd(20)} ${r.date.slice(0, 10)} [${r.vendor}]${r.matched ? ` (${r.matched})` : ''} ${r.snippet.replace(/\s+/g, ' ').slice(0, 74)}`;

const occurrences = (doc, re) => (doc.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) ?? []).length;
const targetRank = (results, sig, min, proj) => {
  if (!sig) return null;
  for (let i = 0; i < Math.min(results.length, TOP); i++) {
    if (proj && !(results[i].projectPath || '').toUpperCase().includes(proj.toUpperCase())) continue;
    if (occurrences(getSessionDoc(results[i].sessionId), sig) >= min) return i + 1;
  }
  return null;
};

console.log('Tier-1 hybrid eval — keyword-only vs keyword+vector-index');
console.log('==========================================================\n');

const summary = [];
for (const t of TESTS) {
  console.log(`◆ QUERY: "${t.q}"${t.sig ? `   (target doc contains ${t.sig} ×${t.min}+)` : ''}`);

  process.env.CLDCTRL_SEMANTIC = '0';
  const t0 = Date.now();
  const kw = await searchConversationsSmart(t.q, TOP);
  const kwMs = Date.now() - t0;

  process.env.CLDCTRL_SEMANTIC = '1';
  const t1 = Date.now();
  const hy = await searchConversationsSmart(t.q, TOP);
  const hyMs = Date.now() - t1;

  if (!hy.semantic) console.log('  ⚠ hybrid did NOT run (embedder unavailable/timed out) — both columns are keyword order');

  const kwRank = targetRank(kw.results, t.sig, t.min, t.proj);
  const hyRank = targetRank(hy.results, t.sig, t.min, t.proj);
  const vecOnly = hy.results.slice(0, SHOW).filter((r) => r.matched === 'vector');

  console.log(`  keyword ${kwMs}ms | hybrid ${hyMs}ms`);
  console.log(`  KEYWORD top ${SHOW}${t.sig ? `  → target at rank ${kwRank ?? `>${TOP} (MISSED)`}` : ''}`);
  kw.results.slice(0, SHOW).forEach((r, i) => console.log(`    #${i + 1} ${fmt(r)}`));
  console.log(`  HYBRID  top ${SHOW}${t.sig ? `  → target at rank ${hyRank ?? `>${TOP} (MISSED)`}` : ''}`);
  hy.results.slice(0, SHOW).forEach((r, i) => console.log(`    #${i + 1} ${fmt(r)}`));
  if (vecOnly.length) console.log(`  ★ ${vecOnly.length} top-${SHOW} result(s) keyword missed entirely (marked "vector")`);
  console.log('');

  if (t.sig) summary.push({ q: t.q, kwRank, hyRank });
}

if (summary.length) {
  console.log('Summary — rank of the verified-correct conversation (lower is better):');
  for (const s of summary) {
    const verdict = s.hyRank && (!s.kwRank || s.hyRank < s.kwRank) ? '✓ hybrid wins'
      : s.kwRank && (!s.hyRank || s.kwRank < s.hyRank) ? '✗ keyword wins'
      : s.hyRank ? '= tie' : '– both missed';
    console.log(`  kw ${String(s.kwRank ?? '—').padStart(3)} → hy ${String(s.hyRank ?? '—').padStart(3)}  ${verdict}  "${s.q.slice(0, 60)}"`);
  }
}
