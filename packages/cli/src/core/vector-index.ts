/**
 * Tier-1 semantic search: a PERSISTENT local vector index over the whole
 * conversation corpus (Claude JSONL + Codex rollouts).
 *
 * Tier-0 (semantic-rerank.ts) could only re-order what keyword search already
 * found. This layer provides true semantic RECALL: every session doc from the
 * content index (conversation-search.ts) is chunked and embedded once, vectors
 * are persisted under <configDir>, and a query is answered by brute-force
 * cosine over all chunks — so "make the terminal stop flashing" finds the
 * flicker conversation even when no query word appears in it.
 *
 * Design notes:
 * - Storage: `semantic-vindex.json` (meta + per-chunk snippets) plus
 *   `semantic-vindex.vec` (raw little-endian Float32 vectors, one row per
 *   chunk). A realistic personal corpus (~120 sessions, ~3M extracted chars)
 *   is ~3.5k chunks ≈ 5.4MB of vectors; the hard caps below bound it at
 *   ~15MB. Meta is written after vectors and validated against the vector
 *   file's byte length on load, so a crash between the two writes just
 *   invalidates the index (rebuilt incrementally on next use).
 * - Incremental: each session is keyed by the sha1 of its extracted doc.
 *   Unchanged sessions reuse their stored vectors; only new/changed docs are
 *   embedded, and the per-chunk content-hash cache in embeddings.ts makes
 *   even interrupted builds resumable. Each ensure call embeds at most a
 *   caller-set chunk budget, so a search never stalls behind a full corpus
 *   build — the index converges over a few queries (or via
 *   buildVectorIndexFull for an eager build).
 * - Brute force on purpose: ~10k chunks × 384 dims is ~4M multiply-adds per
 *   query — well under a millisecond. An ANN library (or native vector DB)
 *   would add a dependency for zero user-visible win at this corpus size.
 * - Everything degrades softly: no embedder ⇒ ensure/search return null and
 *   callers fall back to keyword ranking. Nothing here runs on the startup
 *   path; callers import this module lazily behind the `search.semantic` flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';
import { listSessionDocs, type Vendor } from './conversation-search.js';
import { embedCached, flushEmbeddingCache, hashText } from './embeddings.js';
import { log } from './logger.js';

const VINDEX_VERSION = 1;
const CHUNK_CHARS = 1000;          // ≈ the MiniLM 512-token window
const CHUNK_OVERLAP = 150;         // consecutive chunks share this much context
const SNIPPET_CHARS = 200;         // stored per chunk — becomes the matched-passage snippet
const MAX_SESSIONS = 400;          // newest-first; older sessions are dropped (logged)
const MAX_CHUNKS_PER_SESSION = 40; // beyond this, windows are sampled evenly across the doc
const MAX_TOTAL_CHUNKS = 10_000;   // ≈15MB of Float32 vectors — the overall disk bound
const MIN_COSINE = 0.3;            // below this a vector hit is noise, not recall

export const DEFAULT_EMBED_BUDGET = 600; // chunks embedded per ensure call (≈ a few seconds CPU)

export interface VectorHit {
  sessionId: string;
  /** Best-chunk cosine similarity to the query (normalized vectors ⇒ dot product). */
  score: number;
  /** The matched passage — the start of the best-scoring chunk. */
  snippet: string;
  projectPath: string;
  vendor: Vendor;
  lastTs: number;
  /** Number of this session's chunks above the similarity floor. */
  matches: number;
}

export interface EnsureResult {
  /** Sessions currently in the index. */
  sessions: number;
  totalChunks: number;
  /** Sessions still waiting to be embedded (budget ran out). */
  pendingSessions: number;
  /** Chunks embedded by THIS call. */
  embeddedChunks: number;
  /** Sessions excluded by the caps (MAX_SESSIONS / MAX_TOTAL_CHUNKS). */
  droppedSessions: number;
  /** True when every in-cap session is embedded and stored. */
  complete: boolean;
}

interface VChunk { off: number; s: string } // row in the .vec file + snippet
interface VSession { hash: string; projectPath: string; vendor: Vendor; lastTs: number; chunks: VChunk[] }
interface VMeta { version: number; model: string; dim: number; totalChunks: number; sessions: Record<string, VSession> }

interface MemIndex { meta: VMeta; vectors: Float32Array }
let mem: MemIndex | null = null;

function metaPath(): string { return path.join(getConfigDir(), 'semantic-vindex.json'); }
function vecPath(): string { return path.join(getConfigDir(), 'semantic-vindex.vec'); }

function loadDisk(): MemIndex | null {
  try {
    const meta: VMeta = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
    if (meta.version !== VINDEX_VERSION || !meta.sessions || !meta.dim) return null;
    const buf = fs.readFileSync(vecPath());
    if (buf.byteLength !== meta.totalChunks * meta.dim * 4) return null; // meta/vec mismatch (crash mid-write)
    // Copy into a fresh (4-byte-aligned) buffer — Buffer offsets aren't guaranteed aligned.
    const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return { meta, vectors };
  } catch { return null; }
}

function persist(idx: MemIndex): void {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    const v = idx.vectors;
    // Vectors first, meta second: load() validates lengths, so a crash between
    // the two renames leaves a self-invalidating (not corrupt) index.
    const vTmp = vecPath() + '.tmp';
    fs.writeFileSync(vTmp, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    fs.renameSync(vTmp, vecPath());
    const mTmp = metaPath() + '.tmp';
    fs.writeFileSync(mTmp, JSON.stringify(idx.meta));
    fs.renameSync(mTmp, metaPath());
  } catch { /* best-effort — the index rebuilds incrementally */ }
}

/**
 * Split a session doc into overlapping embedding-window chunks. Docs too long
 * for the per-session cap get evenly sampled windows across the WHOLE doc, so
 * late-session content is still represented (unlike the head-only 40k doc cap).
 */
export function chunkText(doc: string): string[] {
  const text = doc.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const step = CHUNK_CHARS - CHUNK_OVERLAP;
  const naive = text.length <= CHUNK_CHARS ? 1 : Math.ceil((text.length - CHUNK_CHARS) / step) + 1;
  const chunks: string[] = [];
  if (naive <= MAX_CHUNKS_PER_SESSION) {
    for (let i = 0; i < naive; i++) chunks.push(text.slice(i * step, i * step + CHUNK_CHARS));
  } else {
    for (let i = 0; i < MAX_CHUNKS_PER_SESSION; i++) {
      const start = Math.round((i * (text.length - CHUNK_CHARS)) / (MAX_CHUNKS_PER_SESSION - 1));
      chunks.push(text.slice(start, start + CHUNK_CHARS));
    }
  }
  return chunks;
}

/**
 * Reconcile the persistent index with the current corpus, embedding up to
 * `maxEmbedChunks` new/changed chunks (sessions listed in `prioritySessionIds`
 * — e.g. the current keyword pool — are embedded first). Returns the index
 * state, or null when the local embedder is unavailable (callers fall back to
 * keyword search). Never throws.
 */
export async function ensureVectorIndex(opts: { maxEmbedChunks?: number; prioritySessionIds?: string[] } = {}): Promise<EnsureResult | null> {
  const budget = opts.maxEmbedChunks ?? DEFAULT_EMBED_BUDGET;

  // Plan: newest sessions first, under the session + total-chunk caps.
  const docs = listSessionDocs().filter((d) => d.doc).sort((a, b) => b.lastTs - a.lastTs);
  let droppedSessions = Math.max(0, docs.length - MAX_SESSIONS);
  const plan = new Map<string, { hash: string; chunks: string[]; projectPath: string; vendor: Vendor; lastTs: number }>();
  let planned = 0;
  for (const d of docs.slice(0, MAX_SESSIONS)) {
    const chunks = chunkText(d.doc);
    if (!chunks.length) continue;
    if (planned + chunks.length > MAX_TOTAL_CHUNKS) {
      droppedSessions += Math.max(0, Math.min(docs.length, MAX_SESSIONS) - plan.size); // everything older than the cap point
      break;
    }
    planned += chunks.length;
    plan.set(d.sessionId, { hash: hashText(d.doc), chunks, projectPath: d.projectPath, vendor: d.vendor, lastTs: d.lastTs });
  }

  const cur = mem ?? loadDisk() ?? { meta: { version: VINDEX_VERSION, model: '', dim: 0, totalChunks: 0, sessions: {} }, vectors: new Float32Array(0) };

  // Classify: reusable (same content hash) vs pending (new/changed).
  const reusable = new Set<string>();
  const pending: string[] = [];
  for (const [id, p] of plan) {
    const ex = cur.meta.sessions[id];
    if (ex && ex.hash === p.hash && ex.chunks.length === p.chunks.length) reusable.add(id);
    else pending.push(id);
  }
  const prio = new Set(opts.prioritySessionIds ?? []);
  if (prio.size) pending.sort((a, b) => (prio.has(b) ? 1 : 0) - (prio.has(a) ? 1 : 0)); // stable: recency order otherwise

  // Embed pending sessions (whole sessions at a time) up to the budget.
  const embedded = new Map<string, Float32Array[]>();
  let embeddedChunks = 0;
  for (const id of pending) {
    if (embeddedChunks >= budget) break;
    const p = plan.get(id)!;
    const vecs = await embedCached(p.chunks);
    if (!vecs) {
      flushEmbeddingCache();
      return null; // embedder unavailable — semantic layer off for this process
    }
    embedded.set(id, vecs);
    embeddedChunks += p.chunks.length;
  }
  flushEmbeddingCache();

  const removed = Object.keys(cur.meta.sessions).some((id) => !plan.has(id)); // fell out of the caps / deleted
  const changed = embedded.size > 0 || removed;

  if (changed) {
    const dim = cur.meta.dim || embedded.values().next().value?.[0]?.length || 384;
    // Rebuild compact, in plan order (newest first). Three cases per session:
    // freshly embedded (new rows), hash-unchanged (copy old rows), or
    // content-changed but over budget this round — carry the STALE entry
    // (old hash included, so it stays pending) rather than dropping it.
    let total = 0;
    for (const [id, p] of plan) {
      if (embedded.has(id)) total += p.chunks.length;
      else if (cur.meta.sessions[id]) total += cur.meta.sessions[id].chunks.length;
    }
    const sessions: Record<string, VSession> = {};
    const vectors = new Float32Array(total * dim);
    let row = 0;
    for (const [id, p] of plan) {
      const newVecs = embedded.get(id);
      const old = cur.meta.sessions[id];
      if (!newVecs && !old) continue; // brand-new session still pending — next call
      const chunks: VChunk[] = [];
      const n = newVecs ? p.chunks.length : old.chunks.length;
      for (let i = 0; i < n; i++) {
        if (newVecs) vectors.set(newVecs[i], row * dim);
        else vectors.set(cur.vectors.subarray(old.chunks[i].off * dim, (old.chunks[i].off + 1) * dim), row * dim);
        chunks.push({ off: row, s: newVecs ? p.chunks[i].slice(0, SNIPPET_CHARS) : old.chunks[i].s });
        row++;
      }
      sessions[id] = newVecs
        ? { hash: p.hash, projectPath: p.projectPath, vendor: p.vendor, lastTs: p.lastTs, chunks }
        : { ...old, chunks }; // keep the old hash — content-changed entries remain pending
    }
    mem = { meta: { version: VINDEX_VERSION, model: cur.meta.model || 'Xenova/all-MiniLM-L6-v2', dim, totalChunks: total, sessions }, vectors };
    persist(mem);
  } else if (!mem) {
    mem = cur;
  }

  const result: EnsureResult = {
    sessions: Object.keys(mem.meta.sessions).length,
    totalChunks: mem.meta.totalChunks,
    pendingSessions: pending.length - embedded.size,
    embeddedChunks,
    droppedSessions,
    complete: pending.length === embedded.size,
  };
  if (changed || result.pendingSessions > 0 || droppedSessions > 0) log('vindex', result as unknown as Record<string, unknown>);
  return result;
}

/**
 * Semantic search over the persistent index: embed the query, brute-force
 * cosine over every chunk, return the best sessions (deduped — one hit per
 * session, scored/snippeted by its best chunk). Returns [] on an empty index
 * and null when the embedder is unavailable.
 */
export async function vectorSearchSessions(query: string, k = 20): Promise<VectorHit[] | null> {
  const idx = mem ?? loadDisk();
  if (idx) mem = idx;
  if (!idx || !idx.meta.totalChunks) return [];
  const qvecs = await embedCached([query]);
  flushEmbeddingCache();
  if (!qvecs) return null;
  const qv = qvecs[0];
  const { meta, vectors } = idx;
  const dim = meta.dim;

  const hits: VectorHit[] = [];
  for (const [id, s] of Object.entries(meta.sessions)) {
    let best = -1;
    let bestSnippet = '';
    let matches = 0;
    for (const c of s.chunks) {
      const base = c.off * dim;
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += qv[i] * vectors[base + i];
      if (dot >= MIN_COSINE) matches++;
      if (dot > best) { best = dot; bestSnippet = c.s; }
    }
    if (best >= MIN_COSINE) {
      hits.push({ sessionId: id, score: best, snippet: bestSnippet, projectPath: s.projectPath, vendor: s.vendor, lastTs: s.lastTs, matches });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.lastTs - a.lastTs);
  return hits.slice(0, k);
}

/**
 * Eagerly build the whole index (eval harness / explicit warm-up). Loops
 * ensure calls until complete; reports progress per batch. Null ⇒ no embedder.
 */
export async function buildVectorIndexFull(opts: { batch?: number; onProgress?: (s: EnsureResult) => void } = {}): Promise<EnsureResult | null> {
  for (;;) {
    const r = await ensureVectorIndex({ maxEmbedChunks: opts.batch ?? 1000 });
    if (!r) return null;
    opts.onProgress?.(r);
    if (r.complete || r.embeddedChunks === 0) return r;
  }
}

/** Test/eval hook: drop the in-memory index so the next call re-reads disk. */
export function __resetVectorIndexMem(): void { mem = null; }
