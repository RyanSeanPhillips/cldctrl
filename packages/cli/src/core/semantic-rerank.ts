/**
 * Tier-0 semantic search: a query-time semantic RE-RANK of the keyword
 * content-index results (conversation-search.ts).
 *
 * The keyword pass stays the recall gate — it's fast, exact-identifier-friendly,
 * and needs no model. This layer re-scores its top candidates by embedding
 * similarity to the query's *meaning*, so conceptual matches ("what did we
 * decide about the idle threshold") outrank coincidental keyword hits. The final
 * order blends both signals; keyword-only callers are unaffected.
 *
 * Feature-flagged (config `search.semantic`, default OFF; CLDCTRL_SEMANTIC=1/0
 * overrides) and fully optional: if the local embedder (see embeddings.ts) is
 * missing or slow, results fall back to pure keyword order — never an error,
 * never a startup cost. This is deliberately NOT a vector index over the whole
 * corpus (that's a later slice); it only embeds the candidate set per query,
 * with content-hash caching so repeat queries are cheap.
 */
import { searchConversations, getSessionDoc, type SearchResult } from './conversation-search.js';
import { loadConfig } from '../config.js';

const RERANK_POOL = 30;        // keyword candidates considered for re-ranking
const CHUNK_CHARS = 1100;      // ≈ the model's 512-token window; MiniLM truncates beyond it
const MAX_CHUNKS_PER_DOC = 8;  // spread across the doc, not just the head
const SEMANTIC_WEIGHT = 0.6;   // blend: 0.6 semantic + 0.4 normalized keyword score
const TIME_BUDGET_MS = 30_000; // first run pays model load/download; falls back past this

export interface SmartSearchResult {
  results: SearchResult[];
  /** True when semantic re-ranking was actually applied (flag on + embedder available in time). */
  semantic: boolean;
}

export function semanticSearchEnabled(): boolean {
  const env = process.env.CLDCTRL_SEMANTIC;
  if (env === '1') return true;
  if (env === '0') return false;
  try {
    const { config } = loadConfig();
    return config.search?.semantic === true;
  } catch {
    return false;
  }
}

/**
 * Drop-in async wrapper over searchConversations(): identical recall set and
 * result shape, semantically re-ranked when the feature is enabled. On ANY
 * failure or timeout it returns the plain keyword ranking.
 */
export async function searchConversationsSmart(query: string, limit = 50, project?: string): Promise<SmartSearchResult> {
  // Over-fetch so re-ranking sees a real pool even for small limits.
  const keyword = searchConversations(query, Math.max(limit, RERANK_POOL), project);
  if (!semanticSearchEnabled() || keyword.length < 2) {
    return { results: keyword.slice(0, limit), semantic: false };
  }
  try {
    const reranked = await withTimeout(rerank(query, keyword), TIME_BUDGET_MS);
    if (reranked) return { results: reranked.slice(0, limit), semantic: true };
  } catch { /* fall through to keyword */ }
  return { results: keyword.slice(0, limit), semantic: false };
}

/** Chunk a session doc into embedding-window-sized pieces spread across the doc. */
function chunkDoc(doc: string): string[] {
  const text = doc.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const total = Math.ceil(text.length / CHUNK_CHARS);
  const chunks: string[] = [];
  if (total <= MAX_CHUNKS_PER_DOC) {
    for (let i = 0; i < total; i++) chunks.push(text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
  } else {
    // Evenly sample windows across the doc so late-session content still counts.
    for (let i = 0; i < MAX_CHUNKS_PER_DOC; i++) {
      const start = Math.round((i * (text.length - CHUNK_CHARS)) / (MAX_CHUNKS_PER_DOC - 1));
      chunks.push(text.slice(start, start + CHUNK_CHARS));
    }
  }
  return chunks;
}

async function rerank(query: string, keyword: SearchResult[]): Promise<SearchResult[] | null> {
  const { embedCached, cosine, flushEmbeddingCache } = await import('./embeddings.js');

  const pool = keyword.slice(0, RERANK_POOL);
  const rest = keyword.slice(RERANK_POOL); // beyond the pool: keep keyword order

  // Collect texts: query first, then each candidate's chunks.
  const texts: string[] = [query];
  const spans: Array<{ start: number; end: number }> = [];
  for (const r of pool) {
    const chunks = chunkDoc(getSessionDoc(r.sessionId));
    spans.push({ start: texts.length, end: texts.length + chunks.length });
    texts.push(...chunks);
  }

  const vecs = await embedCached(texts);
  if (!vecs) return null; // embedder unavailable
  flushEmbeddingCache();

  const qv = vecs[0];
  // Keyword signal = rank position (not the raw score): the coverage*1000 score
  // isn't exposed on SearchResult, and rank already encodes coverage+occurrence+recency.
  const n = pool.length;
  const blended = pool.map((r, i) => {
    let sem = 0;
    for (let j = spans[i].start; j < spans[i].end; j++) {
      const c = cosine(qv, vecs[j]);
      if (c > sem) sem = c; // best-passage semantics
    }
    const kwNorm = n > 1 ? (n - 1 - i) / (n - 1) : 1; // 1.0 for keyword rank #1 → 0.0 for last
    return { r, score: SEMANTIC_WEIGHT * sem + (1 - SEMANTIC_WEIGHT) * kwNorm, sem };
  });

  blended.sort((a, b) => b.score - a.score);
  return [...blended.map((b) => b.r), ...rest];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    if (typeof (t as any).unref === 'function') (t as any).unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
