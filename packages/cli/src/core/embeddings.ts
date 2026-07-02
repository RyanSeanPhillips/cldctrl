/**
 * Local text embeddings for semantic search — OPTIONAL and lazy.
 *
 * Anthropic has no embeddings API, and cldctrl's positioning is data-stays-local,
 * so embeddings run fully offline via transformers.js (ONNX). The package is NOT
 * a dependency of cldctrl — zero-config install stays untouched. To enable:
 *
 *   npm i -g @huggingface/transformers     (or @xenova/transformers)
 *   + set config `search.semantic: true`   (or CLDCTRL_SEMANTIC=1)
 *
 * If the module (or the model download) is unavailable, every entry point here
 * resolves to null and callers silently fall back to keyword ranking. Nothing on
 * the startup path imports this file eagerly.
 *
 * Vectors are cached by content hash in <configDir>/semantic-cache.json so
 * re-ranking an unchanged corpus costs zero model inference.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfigDir } from '../config.js';

export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384-dim, ~23MB quantized ONNX

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// Candidate module names, tried in order. A path override (env) wins — useful for
// dev/eval setups where the package lives outside cldctrl's resolution tree.
const EMBED_PKGS = ['@huggingface/transformers', '@xenova/transformers'];

let embedderPromise: Promise<Embedder | null> | null = null;

/**
 * Lazily load the transformers.js pipeline. Resolves null (and remembers the
 * failure for this process) if the optional package or model isn't available.
 * First successful call may download model weights (~23MB) to
 * <configDir>/models — subsequent runs are fully offline.
 */
export function getEmbedder(model = DEFAULT_EMBED_MODEL): Promise<Embedder | null> {
  if (!embedderPromise) embedderPromise = loadEmbedder(model);
  return embedderPromise;
}

async function loadEmbedder(model: string): Promise<Embedder | null> {
  const specs = [...EMBED_PKGS];
  const override = process.env.CLDCTRL_EMBED_PKG;
  if (override) specs.unshift(override.startsWith('file:') || path.isAbsolute(override)
    ? (await import('node:url')).pathToFileURL(path.resolve(override.replace(/^file:/, ''))).href
    : override);

  let mod: any = null;
  for (const spec of specs) {
    try {
      mod = await import(spec);
      if (mod?.pipeline) break;
      mod = null;
    } catch { /* try next candidate */ }
  }
  if (!mod?.pipeline) return null;

  try {
    // Keep model files under our config dir (predictable, user-cleanable).
    if (mod.env) {
      mod.env.cacheDir = path.join(getConfigDir(), 'models');
      mod.env.allowLocalModels = true;
    }
    // `quantized` is the v2 (@xenova) option, `dtype` the v3 (@huggingface) one —
    // each version ignores the other's key.
    const extractor = await mod.pipeline('feature-extraction', model, { quantized: true, dtype: 'q8' });
    return {
      model,
      async embed(texts: string[]): Promise<Float32Array[]> {
        if (!texts.length) return [];
        const out = await extractor(texts, { pooling: 'mean', normalize: true });
        const data: Float32Array = out.data;
        const dim = data.length / texts.length;
        const vecs: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) vecs.push(data.slice(i * dim, (i + 1) * dim));
        return vecs;
      },
    };
  } catch {
    return null; // model load/download failed — stay on keyword ranking
  }
}

/** Dot product == cosine similarity for the normalized vectors we produce. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ── Persistent vector cache (content-hash keyed) ─────────────

const CACHE_VERSION = 1;
const CACHE_MAX_ENTRIES = 4000; // ~2KB/vector → ≤ ~8MB on disk

interface CacheEntry { v: string; at: number } // base64 Float32Array, last-used ms
interface DiskCache { version: number; model: string; entries: Record<string, CacheEntry> }

let memCache: { model: string; entries: Map<string, { vec: Float32Array; at: number }> } | null = null;
let cacheDirty = false;

function cachePath(): string { return path.join(getConfigDir(), 'semantic-cache.json'); }

export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function loadCache(model: string): Map<string, { vec: Float32Array; at: number }> {
  if (memCache && memCache.model === model) return memCache.entries;
  const entries = new Map<string, { vec: Float32Array; at: number }>();
  try {
    const disk: DiskCache = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    if (disk.version === CACHE_VERSION && disk.model === model && disk.entries) {
      for (const [k, e] of Object.entries(disk.entries)) {
        const buf = Buffer.from(e.v, 'base64');
        entries.set(k, { vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), at: e.at });
      }
    }
  } catch { /* no/invalid cache */ }
  memCache = { model, entries };
  return entries;
}

export function flushEmbeddingCache(): void {
  if (!memCache || !cacheDirty) return;
  try {
    const entries = memCache.entries;
    // Evict least-recently-used beyond the cap.
    if (entries.size > CACHE_MAX_ENTRIES) {
      const sorted = [...entries.entries()].sort((a, b) => b[1].at - a[1].at);
      memCache.entries = new Map(sorted.slice(0, CACHE_MAX_ENTRIES));
    }
    const out: DiskCache = { version: CACHE_VERSION, model: memCache.model, entries: {} };
    for (const [k, e] of memCache.entries) {
      out.entries[k] = { v: Buffer.from(e.vec.buffer, e.vec.byteOffset, e.vec.byteLength).toString('base64'), at: e.at };
    }
    const tmp = cachePath() + '.tmp';
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, cachePath());
    cacheDirty = false;
  } catch { /* best-effort */ }
}

/**
 * Embed texts through the content-hash cache: unchanged texts never touch the
 * model. Returns null if the embedder is unavailable. Call
 * `flushEmbeddingCache()` after a batch to persist new vectors.
 */
export async function embedCached(texts: string[], model = DEFAULT_EMBED_MODEL): Promise<Float32Array[] | null> {
  const cache = loadCache(model);
  const now = Date.now();
  const result: (Float32Array | null)[] = new Array(texts.length).fill(null);
  const missIdx: number[] = [];
  const missKeys: string[] = [];

  texts.forEach((t, i) => {
    const key = hashText(t);
    const hit = cache.get(key);
    if (hit) { hit.at = now; result[i] = hit.vec; }
    else { missIdx.push(i); missKeys.push(key); }
  });

  if (missIdx.length) {
    const embedder = await getEmbedder(model);
    if (!embedder) return null;
    // Small batches keep peak memory + single-call latency sane.
    const BATCH = 16;
    for (let off = 0; off < missIdx.length; off += BATCH) {
      const idxs = missIdx.slice(off, off + BATCH);
      const vecs = await embedder.embed(idxs.map((i) => texts[i]));
      idxs.forEach((textIdx, j) => {
        result[textIdx] = vecs[j];
        cache.set(missKeys[off + j], { vec: vecs[j], at: now });
        cacheDirty = true;
      });
    }
  }
  return result as Float32Array[];
}
