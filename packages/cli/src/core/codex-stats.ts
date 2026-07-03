/**
 * Codex usage for the Stats tab. OpenAI Codex CLI rollouts
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) emit `token_count` events with
 * cumulative + per-turn token usage — parsed here into the same raw-turn shape
 * core/stats.ts uses for Claude, so Codex sessions drop straight into the shared
 * usage timeline (tagged vendor:'codex'). Kept separate from stats.ts so the
 * Claude path is untouched and this can no-op cleanly when ~/.codex is absent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface CodexRawTurn { ts: number; session: string; total: number; billed: number; ctx: number; flag: 0 }
export interface CodexUsage {
  turns: CodexRawTurn[];
  sessions: Map<string, { cwd: string }>;   // sessionId → project cwd (for labels)
  latestRateLimit: { usedPercent: number; windowMinutes?: number; resetsInSeconds?: number } | null;
}

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function codexRoot(): string { return path.join(os.homedir(), '.codex', 'sessions'); }

function walkFiles(): Array<{ sessionId: string; filePath: string }> {
  const root = codexRoot();
  const out: Array<{ sessionId: string; filePath: string }> = [];
  const kids = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const y of kids(root)) {
    if (!y.isDirectory()) continue;
    for (const m of kids(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of kids(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dayDir = path.join(root, y.name, m.name, d.name);
        for (const f of kids(dayDir)) {
          if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
          const uuid = f.name.match(UUID_RE);
          out.push({ sessionId: uuid ? uuid[1] : f.name.replace(/\.jsonl$/, ''), filePath: path.join(dayDir, f.name) });
        }
      }
    }
  }
  return out;
}

// Light Codex rate-limit read for the sidebar usage zone (overview polls every
// 3s, so this must be cheap): read ONLY the newest rollout's tail and grab the
// last rate_limits event. Cached with a TTL so repeated polls don't re-read.
export interface CodexRate { usedPercent: number; windowMinutes?: number; resetsInSeconds?: number }
let rateCache: { at: number; value: CodexRate | null } | null = null;
const RATE_TTL = 60_000;

export function getCodexRateLimitCached(now: number): CodexRate | null {
  if (rateCache && now - rateCache.at < RATE_TTL) return rateCache.value;
  let value: CodexRate | null = null;
  try {
    // newest rollout file by mtime
    let newest = '', newestM = 0;
    for (const { filePath } of walkFiles()) {
      let m = 0; try { m = fs.statSync(filePath).mtimeMs; } catch { continue; }
      if (m > newestM) { newestM = m; newest = filePath; }
    }
    if (newest && now - newestM < 30 * 864e5) {
      const size = fs.statSync(newest).size;
      const readLen = Math.min(size, 96 * 1024);
      const fd = fs.openSync(newest, 'r');
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const idx = text.lastIndexOf('"rate_limits"');
      if (idx >= 0) {
        // parse the enclosing JSON line
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        let lineEnd = text.indexOf('\n', idx); if (lineEnd < 0) lineEnd = text.length;
        try {
          const obj = JSON.parse(text.slice(lineStart, lineEnd));
          const primary = obj?.payload?.rate_limits?.primary;
          if (primary && Number.isFinite(Number(primary.used_percent))) {
            const resetsAt = Number(primary.resets_at);
            value = {
              usedPercent: Number(primary.used_percent),
              windowMinutes: Number(primary.window_minutes) || undefined,
              resetsInSeconds: resetsAt > 0 ? Math.max(0, Math.round(resetsAt - now / 1000)) : undefined,
            };
          }
        } catch { /* partial line — skip */ }
      }
    }
  } catch { /* no codex / read error → null */ }
  rateCache = { at: now, value };
  return value;
}

// Recent Codex sessions for the sidebar conversation list. Cheap + cached: sort
// rollouts by mtime, take the newest within the window, read each one's head for
// cwd (session_meta) — bounded by `limit`. The caller filters to known projects.
export interface CodexSession { sessionId: string; cwd: string; lastTs: number }
let sessCache: { at: number; key: string; value: CodexSession[] } | null = null;
const SESS_TTL = 30_000;

export function listRecentCodexSessions(now: number, windowMs: number, limit = 30): CodexSession[] {
  const key = windowMs + ':' + limit; // don't return a cached window for different args
  if (sessCache && sessCache.key === key && now - sessCache.at < SESS_TTL) return sessCache.value;
  const out: CodexSession[] = [];
  try {
    const files = walkFiles()
      .map((f) => { let m = 0; try { m = fs.statSync(f.filePath).mtimeMs; } catch { /* skip */ } return { ...f, m }; })
      .filter((f) => f.m > 0 && now - f.m <= windowMs)
      .sort((a, b) => b.m - a.m)
      .slice(0, limit);
    for (const f of files) {
      let cwd = '';
      try {
        const fd = fs.openSync(f.filePath, 'r');
        const buf = Buffer.alloc(16 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) cwd = m[1].replace(/\\\\/g, '\\');
      } catch { /* head unreadable — skip cwd */ }
      if (cwd) out.push({ sessionId: f.sessionId, cwd, lastTs: f.m });
    }
  } catch { /* no ~/.codex */ }
  sessCache = { at: now, key, value: out };
  return out;
}

/** Collect Codex token usage across recent rollouts, in the shared raw-turn shape. */
export async function collectCodexUsage(now: number, windowMs: number, freshMs: number): Promise<CodexUsage> {
  const turns: CodexRawTurn[] = [];
  const sessions = new Map<string, { cwd: string }>();
  let latestRateLimit: CodexUsage['latestRateLimit'] = null;
  let latestRateTs = 0;
  const windowStart = now - windowMs;

  for (const { sessionId, filePath } of walkFiles()) {
    let fst: fs.Stats; try { fst = fs.statSync(filePath); } catch { continue; }
    if (now - fst.mtimeMs > freshMs) continue; // skip stale files entirely

    let cwd = '';
    let stream: fs.ReadStream;
    try { stream = fs.createReadStream(filePath, { encoding: 'utf8' }); } catch { continue; }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      const p = obj.payload;
      if (obj.type === 'session_meta' && p) {
        if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
        continue;
      }
      if (obj.type === 'turn_context' && p && !cwd && typeof p.cwd === 'string') { cwd = p.cwd; continue; }
      if (obj.type === 'event_msg' && p && p.type === 'token_count' && p.info) {
        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : 0;
        const last = p.info.last_token_usage || {};
        const cum = p.info.total_token_usage || {};
        const perTurn = Number(last.total_tokens) || 0;
        if (ts >= windowStart && perTurn > 0) {
          turns.push({
            ts,
            session: sessionId,
            total: perTurn,
            billed: (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0) + (Number(last.reasoning_output_tokens) || 0),
            ctx: Number(cum.total_tokens) || perTurn,
            flag: 0,
          });
        }
        // Codex's own rate-limit window (surfaced beside Claude's 5h/7d). Keep the
        // newest. Shape: payload.rate_limits.primary {used_percent, window_minutes,
        // resets_at (unix seconds)} — the 5h "primary" window is the useful one.
        const rl2 = p.rate_limits;
        if (rl2 && rl2.primary && ts > latestRateTs) {
          const used = Number(rl2.primary.used_percent);
          if (Number.isFinite(used)) {
            latestRateTs = ts;
            const resetsAt = Number(rl2.primary.resets_at); // unix seconds
            latestRateLimit = {
              usedPercent: used,
              windowMinutes: Number(rl2.primary.window_minutes) || undefined,
              resetsInSeconds: resetsAt > 0 ? Math.max(0, Math.round(resetsAt - now / 1000)) : undefined,
            };
          }
        }
      }
    }
    rl.close();
    if (turns.some((t) => t.session === sessionId)) sessions.set(sessionId, { cwd });
  }
  return { turns, sessions, latestRateLimit };
}
