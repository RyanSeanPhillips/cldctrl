/**
 * Semantic search wiring: keyword + vector-index HYBRID.
 *
 * Tier-0 (this file's first life) re-ranked the keyword pass's top candidates
 * by query-time embedding similarity — it could re-ORDER keyword's hits but
 * never surface what keyword missed. Tier-1 (vector-index.ts) adds a
 * persistent local vector index over the whole corpus, so this entry point now
 * does true hybrid retrieval:
 *
 *   keyword results  ─┐
 *                     ├─ union by sessionId → Reciprocal Rank Fusion → ranked
 *   vector-index hits ┘
 *
 * Keyword stays strong for exact identifiers; the vector side finds meaning
 * ("terminal keeps flashing" → the flicker session). Sessions found by BOTH
 * sum their RRF contributions and float to the top. Vector-only results carry
 * the matched PASSAGE as their snippet (`matched: 'vector'`), fixing the
 * Tier-0 caveat where snippets always showed the keyword hit.
 *
 * The keyword pool is also fed to the index builder as the priority embed set,
 * so the semantic signal covers the likeliest candidates first while the rest
 * of the corpus indexes incrementally in the background of successive queries.
 *
 * Feature-flagged (config `search.semantic`, default OFF; CLDCTRL_SEMANTIC=1/0
 * overrides) and fully optional: if the local embedder (see embeddings.ts) is
 * missing or slow, results fall back to pure keyword order — never an error,
 * never a startup cost.
 */
import { searchConversations, type SearchResult } from './conversation-search.js';
import { loadConfig } from '../config.js';
import { buildProjectListFast } from './projects.js';
import { normalizePathForCompare } from './platform.js';
import path from 'node:path';

const KW_POOL = 30;            // keyword candidates fused + prioritized for indexing
const VEC_POOL = 30;           // vector-index hits considered for fusion
const RRF_K = 60;              // reciprocal-rank constant for the keyword side
const TIME_BUDGET_MS = 60_000; // first runs pay model load + incremental indexing; falls back past this

// Vector blending uses the ABSOLUTE cosine similarity, not the vector rank:
// MiniLM sims are comparable across queries (≥0.5 strong, ~0.4 decent, ≤0.32
// noise), so a weak semantic signal contributes ~nothing (hybrid degrades to
// keyword order) while a strong hit can outrank keyword's #1 (1/60 ≈ 0.0167).
const SIM_FLOOR = 0.32;        // sims at/below this add zero
const SIM_CEIL = 0.55;         // sims at/above this get the full weight
const VEC_WEIGHT = 0.03;       // full-weight vector hit ≈ 1.8× keyword rank #1
const VEC_ONLY_MIN = 0.38;     // minimum sim to INJECT a session keyword didn't find

export interface SmartSearchResult {
  results: SearchResult[];
  /** True when the semantic (hybrid) path was actually applied. */
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
 * Drop-in async wrapper over searchConversations(): identical result shape,
 * hybrid keyword+vector retrieval when the feature is enabled. On ANY failure
 * or timeout it returns the plain keyword ranking.
 */
export async function searchConversationsSmart(query: string, limit = 50, project?: string): Promise<SmartSearchResult> {
  // Over-fetch so fusion sees a real pool even for small limits.
  const keyword = searchConversations(query, Math.max(limit, KW_POOL), project);
  if (!semanticSearchEnabled()) {
    return { results: keyword.slice(0, limit), semantic: false };
  }
  try {
    const fused = await withTimeout(hybrid(query, keyword, project), TIME_BUDGET_MS);
    if (fused) return { results: fused.slice(0, limit), semantic: true };
  } catch { /* fall through to keyword */ }
  return { results: keyword.slice(0, limit), semantic: false };
}

/** Union keyword + vector-index results and rank by Reciprocal Rank Fusion. */
async function hybrid(query: string, keyword: SearchResult[], project?: string): Promise<SearchResult[] | null> {
  const { ensureVectorIndex, vectorSearchSessions } = await import('./vector-index.js');

  // Reconcile the index incrementally; embed the current keyword pool first so
  // the most likely candidates get semantic coverage immediately.
  const ensured = await ensureVectorIndex({ prioritySessionIds: keyword.slice(0, KW_POOL).map((r) => r.sessionId) });
  if (!ensured) return null; // no embedder
  let vec = await vectorSearchSessions(query, VEC_POOL);
  if (!vec) return null;

  // Project scoping — mirror searchConversations' name-or-path match.
  const { config } = loadConfig();
  const nameMap = new Map<string, string>();
  for (const p of buildProjectListFast(config)) nameMap.set(normalizePathForCompare(p.path), p.name);
  const nameFor = (projectPath: string): string =>
    nameMap.get(normalizePathForCompare(projectPath)) ?? (path.basename(projectPath || '') || '(unknown)');
  const pf = project?.trim().toLowerCase();
  if (pf) {
    vec = vec.filter((v) => {
      const np = normalizePathForCompare(v.projectPath);
      return nameFor(v.projectPath).toLowerCase().includes(pf) || np.includes(pf.replace(/\\/g, '/'));
    });
  }

  // Blend: keyword contributes by reciprocal rank, vector by similarity.
  // Exact-identifier queries stay keyword-dominated (their vector sims are
  // high too, so they sum); conceptual queries let strong semantic hits rise.
  const simW = (sim: number): number => Math.max(0, Math.min(1, (sim - SIM_FLOOR) / (SIM_CEIL - SIM_FLOOR)));
  const fused = new Map<string, { r: SearchResult; score: number }>();
  keyword.forEach((r, i) => fused.set(r.sessionId, { r: { ...r, matched: 'keyword' }, score: 1 / (RRF_K + i) }));
  for (const v of vec) {
    const w = simW(v.score);
    const ex = fused.get(v.sessionId);
    if (ex) {
      ex.score += VEC_WEIGHT * w;
      if (w > 0) ex.r.matched = 'both';
    } else if (v.score >= VEC_ONLY_MIN) {
      fused.set(v.sessionId, {
        score: VEC_WEIGHT * w,
        r: {
          sessionId: v.sessionId,
          project: nameFor(v.projectPath),
          projectPath: v.projectPath,
          date: new Date(v.lastTs).toISOString(),
          snippet: v.snippet, // the semantically matched passage
          count: v.matches,
          vendor: v.vendor,
          matched: 'vector',
        },
      });
    }
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score || Date.parse(b.r.date) - Date.parse(a.r.date))
    .map((x) => x.r);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    if (typeof (t as any).unref === 'function') (t as any).unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
