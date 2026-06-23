/**
 * Usage-stats aggregation for the cockpit Stats tab. Reads Claude Code JSONL
 * (per-turn usage, tool calls, images, API errors) over a recent window and
 * returns a COMPACT payload the browser renders into SVG charts.
 *
 * Mirrors the analysis in docs/context_analysis.py (cache-miss detection from
 * usage fields). Big files are streamed line-by-line and gated by mtime so a
 * 30-day window stays affordable. Result is cached briefly so range toggles
 * don't re-scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getClaudeProjectsDir } from './platform.js';
import { log } from './logger.js';

const DAY = 86400e3, HOUR = 3600e3;
const CACHE_TTL = 5 * 60e3; // prompt cache ~5min: low cache-hit within this gap = a true eviction

// Short keys keep the JSON small for big windows.
export interface StatsTurn { t: number; s: number; k: number; b: number; c: number; f: 0 | 1 | 2; } // ts, sessionIdx, total, billed, ctx, flag(0 normal/1 eviction/2 reload)
export interface StatsSession { id: string; slug: string; project: string; label: string; total: number; }
export interface StatsTool { name: string; calls: number; resultTokens: number; mcp: boolean; }
export interface StatsImageGroup { s: number; bucket: number; n: number; } // sessionIdx, hour-bucket(ms), count
export interface StatsErr { t: number; s: number; }
export interface StatsPayload {
  days: number;
  turns: StatsTurn[];
  sessions: StatsSession[];
  tools: StatsTool[];
  images: StatsImageGroup[];
  apiErrors: StatsErr[];
  toolResultTokens: number;
  mcpResultTokens: number;
  subagentRuns: number;
  consults: Record<string, number>;
  totalTokens: number;
  imageCount: number;
  limits: { fiveH: number | null; sevenD: number | null }; // live token caps if known (else client placeholder)
  generatedAt: number;
}

function prettyProject(slug: string): string {
  const parts = slug.split('-').filter(Boolean);
  return parts.slice(-2).join('-') || slug;
}

function approxTokens(x: unknown): number {
  let s = 0;
  if (typeof x === 'string') s = x.length;
  else if (Array.isArray(x)) for (const b of x) s += approxTokens(b);
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    s = (o.text || o.content) ? approxTokens(o.text ?? o.content) : JSON.stringify(x).length;
  }
  return Math.round(s / 4);
}
function countImages(content: unknown): number {
  let n = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.type === 'image') n++;
      else if (o.type === 'tool_result') walk(o.content);
    }
  };
  walk(content);
  return n;
}

interface Parsed {
  turns: Array<{ ts: number; session: string; total: number; billed: number; ctx: number; flag: 0 | 1 | 2 }>;
  images: Array<{ ts: number; session: string }>;
  apiErrors: Array<{ ts: number; session: string }>;
}

async function parseFile(fp: string, now: number, windowMs: number, tools: Map<string, { calls: number; resultTokens: number }>, consults: Map<string, number>, counters: { subagents: number }): Promise<Parsed> {
  const out: Parsed = { turns: [], images: [], apiErrors: [] };
  const session = path.basename(fp, '.jsonl');
  let stream: fs.ReadStream;
  try { stream = fs.createReadStream(fp, { encoding: 'utf8' }); } catch { return out; }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const idToName = new Map<string, string>();
  let turnIdx = 0, prevTs: number | null = null;
  const bump = (name: string, field: 'calls' | 'resultTokens', n = 1) => {
    const cur = tools.get(name) ?? { calls: 0, resultTokens: 0 };
    cur[field] += n; tools.set(name, cur);
  };
  for await (const line of rl) {
    if (!line) continue;
    if (line.indexOf('"assistant"') === -1 && line.indexOf('"user"') === -1) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    const inWindow = !!ts && now - ts <= windowMs;

    if (obj.type === 'assistant' && obj.message) {
      const content = obj.message.content;
      if (inWindow && (obj.isApiErrorMessage || (typeof content === 'string' && /API Error|rate.?limit/i.test(content)))) out.apiErrors.push({ ts, session });
      if (Array.isArray(content)) {
        if (inWindow) { const imgs = countImages(content); for (let k = 0; k < imgs; k++) out.images.push({ ts, session }); }
        for (const b of content) {
          if (b?.type === 'tool_use' && b.name) {
            idToName.set(b.id, b.name);
            if (inWindow) {
              bump(b.name, 'calls');
              if (b.name === 'Task') counters.subagents++;
              if (b.name === 'mcp__cldctrl__consult_agent') { const a = b.input?.agent || 'unknown'; consults.set(a, (consults.get(a) || 0) + 1); }
            }
          }
        }
      }
      const u = obj.message.usage;
      if (u && inWindow) {
        const cr = u.cache_read_input_tokens || 0, inp = u.input_tokens || 0, ou = u.output_tokens || 0, cw = u.cache_creation_input_tokens || 0;
        const ctx = cr + inp + cw, total = cr + inp + ou + cw, hitPct = ctx > 0 ? (cr / ctx) * 100 : 0;
        const gap = prevTs == null ? null : ts - prevTs;
        const lowCache = hitPct < 20 && ctx > 5000;
        const isReload = lowCache && (turnIdx === 0 || gap == null || gap > CACHE_TTL);
        const flag: 0 | 1 | 2 = lowCache ? (isReload ? 2 : 1) : 0;
        out.turns.push({ ts, session, total, billed: inp + ou + cw, ctx, flag });
        turnIdx++; prevTs = ts;
      }
    }
    if (obj.type === 'user' && obj.message) {
      const content = obj.message.content;
      if (inWindow && Array.isArray(content)) {
        const imgs = countImages(content); for (let k = 0; k < imgs; k++) out.images.push({ ts, session });
        for (const b of content) if (b?.type === 'tool_result') bump(idToName.get(b.tool_use_id) || 'unknown', 'resultTokens', approxTokens(b.content));
      }
    }
  }
  return out;
}

let cache: { days: number; payload: StatsPayload; at: number } | null = null;

export async function computeStats(days: number): Promise<StatsPayload> {
  const now = Date.now();
  if (cache && cache.days === days && now - cache.at < CACHE_TTL) return cache.payload;
  const windowMs = Math.max(1, days) * DAY;
  const freshMs = windowMs + 2 * DAY;
  const projectsDir = getClaudeProjectsDir();

  const tools = new Map<string, { calls: number; resultTokens: number }>();
  const consults = new Map<string, number>();
  const counters = { subagents: 0 };
  const rawTurns: Array<{ ts: number; session: string; total: number; billed: number; ctx: number; flag: 0 | 1 | 2 }> = [];
  const rawImages: Array<{ ts: number; session: string }> = [];
  const apiErrorsRaw: Array<{ ts: number; session: string }> = [];
  const slugOf = new Map<string, string>(); // session id → slug dir

  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { dirs = []; }
  for (const slug of dirs) {
    const pdir = path.join(projectsDir, slug);
    let st: fs.Stats; try { st = fs.statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const project = prettyProject(slug);
    let files: string[] = [];
    try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, f);
      let fst: fs.Stats; try { fst = fs.statSync(fp); } catch { continue; }
      if (now - fst.mtimeMs > freshMs) continue;
      const parsed = await parseFile(fp, now, windowMs, tools, consults, counters);
      for (const t of parsed.turns) { rawTurns.push(t); slugOf.set(t.session, slug); }
      for (const im of parsed.images) { rawImages.push(im); slugOf.set(im.session, slug); }
      for (const e of parsed.apiErrors) { apiErrorsRaw.push(e); slugOf.set(e.session, slug); }
    }
  }
  rawTurns.sort((a, b) => a.ts - b.ts);

  // session table + index
  const sessTotals = new Map<string, number>();
  for (const t of rawTurns) sessTotals.set(t.session, (sessTotals.get(t.session) || 0) + t.total);
  const sessionIds = [...sessTotals.keys()];
  const idxOf = new Map<string, number>(); sessionIds.forEach((id, i) => idxOf.set(id, i));
  const sessions: StatsSession[] = sessionIds.map((id) => {
    const slug = slugOf.get(id) || '';
    return { id, slug, project: prettyProject(slug), label: prettyProject(slug) + '·' + id.slice(0, 4), total: sessTotals.get(id) || 0 };
  });

  const turns: StatsTurn[] = rawTurns.map((t) => ({ t: t.ts, s: idxOf.get(t.session)!, k: t.total, b: t.billed, c: t.ctx, f: t.flag }));

  // group images per (session, hour-bucket)
  const groups = new Map<string, StatsImageGroup>();
  for (const im of rawImages) {
    const s = idxOf.get(im.session); if (s == null) continue;
    const bucket = Math.floor(im.ts / HOUR) * HOUR;
    const key = s + '|' + bucket;
    const g = groups.get(key) ?? { s, bucket, n: 0 };
    g.n++; groups.set(key, g);
  }

  const toolRows: StatsTool[] = [...tools.entries()]
    .map(([name, v]) => ({ name, calls: v.calls, resultTokens: v.resultTokens, mcp: name.startsWith('mcp__') }))
    .sort((a, b) => b.resultTokens - a.resultTokens).slice(0, 12);
  const toolResultTokens = [...tools.values()].reduce((s, v) => s + v.resultTokens, 0);
  const mcpResultTokens = [...tools.entries()].filter(([n]) => n.startsWith('mcp__')).reduce((s, [, v]) => s + v.resultTokens, 0);

  const payload: StatsPayload = {
    days,
    turns,
    sessions,
    tools: toolRows,
    images: [...groups.values()],
    apiErrors: apiErrorsRaw.map((e) => ({ t: e.ts, s: idxOf.get(e.session) ?? -1 })).filter((e) => e.s >= 0),
    toolResultTokens,
    mcpResultTokens,
    subagentRuns: counters.subagents,
    consults: Object.fromEntries(consults),
    totalTokens: rawTurns.reduce((s, t) => s + t.total, 0),
    imageCount: rawImages.length,
    limits: { fiveH: null, sevenD: null },
    generatedAt: now,
  };
  cache = { days, payload, at: now };
  log('compute_stats', { days, turns: turns.length, sessions: sessions.length, tools: toolRows.length });
  return payload;
}

/** Lazy-load: extract the base64 images for one (session, hour-bucket) on demand. */
export async function readBucketImages(slug: string, sessionId: string, bucketMs: number, opts: { maxImages?: number; maxBytesPerImage?: number } = {}): Promise<string[]> {
  const maxImages = opts.maxImages ?? 12, maxPer = opts.maxBytesPerImage ?? 4_000_000;
  const projectsDir = getClaudeProjectsDir();
  // guard against traversal: slug must be a direct child dir, sessionId a bare name
  if (!/^[A-Za-z0-9._-]+$/.test(slug) || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return [];
  const fp = path.join(projectsDir, slug, sessionId + '.jsonl');
  if (!fp.startsWith(path.join(projectsDir, slug) + path.sep)) return [];
  if (!fs.existsSync(fp)) return [];
  const lo = bucketMs, hi = bucketMs + HOUR;
  const uris: string[] = [];
  const collect = (content: unknown): void => {
    const walk = (x: unknown): void => {
      if (uris.length >= maxImages) return;
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        const o = x as Record<string, any>;
        if (o.type === 'image' && o.source?.type === 'base64' && o.source.data) {
          if (String(o.source.data).length <= maxPer) uris.push(`data:${o.source.media_type || 'image/png'};base64,${o.source.data}`);
        } else if (o.type === 'tool_result') walk(o.content);
      }
    };
    walk(content);
  };
  const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (uris.length >= maxImages) break;
    if (line.indexOf('"image"') === -1) continue;
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!ts || ts < lo || ts >= hi) continue;
    if (obj.message?.content) collect(obj.message.content);
  }
  rl.close();
  return uris;
}
