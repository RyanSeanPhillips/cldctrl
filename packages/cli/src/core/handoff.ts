/**
 * Agent handoff (slice 1): build a HANDOFF BRIEF for continuing a conversation's
 * work on a different agent, entirely from ON-DISK artifacts — so it works even
 * when the outgoing agent is dead / out of tokens (we never ask it for a summary).
 *
 * The brief composes the session's goal + transcript tail (what was discussed),
 * the files it touched (from the activity parser — more reliable than raw git
 * diff, which catches unrelated dirty work), current git status + recent commits
 * (the real state of the work, shared across agents via the project dir), the
 * docked notepad, and a BACKLINK telling the receiving agent which session this
 * continues so it can pull more via read_session / search_conversations.
 *
 * Slice 1 resolves Claude sessions (the JSONL filename is the id). Codex/worktree
 * resolution is a later slice (a vendor-neutral resolveSessionArtifact service).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getClaudeProjectsDir } from './platform.js';
import { extractTranscript } from './summaries.js';
import { parseSessionActivity } from './activity.js';
import { getGitStatus, getRecentCommits } from './git.js';
import { notepadFile } from './dashboard-bridge.js';

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{6,}$/;
const BRIEF_CAP = 16_000; // Codex: bound the injected brief (~12-20k); notepad holds the rest.

export interface HandoffBrief {
  ok: boolean;
  sessionId?: string;
  projectPath?: string;
  project?: string;
  vendor?: string;   // 'claude' | 'codex' | …
  brief?: string;
  error?: string;
}

/** Locate a Claude session's JSONL by id + return its project cwd. Works for
 *  DEAD sessions too (scans the projects dir) — also used by /api/transcript
 *  so the restore picker can peek at conversations from a previous day. */
export function resolveClaudeSession(sessionId: string): { file: string; cwd: string } | null {
  const root = getClaudeProjectsDir();
  let slugs: string[];
  try { slugs = fs.readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const file = path.join(root, slug, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let cwd = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(32 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) cwd = m[1].replace(/\\\\/g, '\\');
    } catch { /* cwd stays empty — brief still useful */ }
    return { file, cwd };
  }
  return null;
}

export async function buildHandoffBrief(sessionId: string): Promise<HandoffBrief> {
  if (!SAFE_SESSION_ID.test(sessionId)) return { ok: false, error: 'Invalid session id.' };

  // Vendor-neutral resolve: prefer the RICH Claude path (transcript tail from the
  // JSONL + touched files from the activity parser). Otherwise fall back to the
  // cross-vendor search index (Codex rollouts, or Claude sessions outside the
  // projects dir) for the doc + cwd + vendor.
  let vendor = 'claude', cwd = '', goal = '', tail = '';
  let touched: string[] = [];
  const claudeFile = resolveClaudeSession(sessionId);
  if (claudeFile) {
    cwd = claudeFile.cwd;
    try {
      const full = extractTranscript(claudeFile.file, 24);
      tail = full;
      const firstUser = full.match(/(?:^|\n)(?:User|Human)[:>]\s*([\s\S]*?)(?:\n(?:Assistant|Claude)[:>]|\n\n|$)/i);
      if (firstUser) goal = firstUser[1].trim().slice(0, 400);
    } catch { /* transcript optional */ }
    try {
      const act = await parseSessionActivity(claudeFile.file);
      if (act?.touchedFiles?.length) {
        touched = act.touchedFiles.filter((t) => t.writes > 0).slice(0, 20).map((t) => t.path);
        if (!touched.length) touched = act.touchedFiles.slice(0, 12).map((t) => t.path);
      }
    } catch { /* activity optional */ }
  } else {
    const { getSessionArtifact } = await import('./conversation-search.js');
    const art = getSessionArtifact(sessionId);
    if (!art) return { ok: false, error: 'Session not found (it may not be indexed yet — open it once in the dashboard, then retry).' };
    vendor = art.vendor;
    cwd = art.projectPath;
    // The index doc is capped from the START of the session (opening + early
    // turns), so it's context rather than the very latest tail — still enough to
    // convey the goal + direction; the new agent reads the repo for current state.
    const doc = art.doc || '';
    tail = doc.length > 6000 ? doc.slice(0, 6000) + '\n…(truncated — see the prior session / repo)' : doc;
    const fu = doc.match(/(?:^|\n)(?:User|Human|You)[:>]\s*([\s\S]*?)(?:\n|$)/i);
    goal = (fu ? fu[1] : doc).trim().slice(0, 400);
  }
  const projectName = cwd ? (cwd.split(/[/\\]/).filter(Boolean).pop() || cwd) : 'this project';

  // Current state of the work = git (corroborating ground truth).
  let gitLine = '', commits = '';
  if (cwd) {
    try {
      const st = await getGitStatus(cwd);
      if (st) gitLine = `branch ${st.branch}${st.dirty ? ` · ${st.dirty} uncommitted change(s)` : ' · clean'}${st.ahead ? ` · ${st.ahead} ahead` : ''}`;
    } catch { /* ignore */ }
    try {
      const cs = await getRecentCommits(cwd, 6);
      if (cs.length) commits = cs.map((c) => `- ${c.hash.slice(0, 8)} ${c.subject.slice(0, 72)}`).join('\n');
    } catch { /* ignore */ }
  }

  // The docked notepad, if any (the shared cross-agent ledger).
  let notepad = '';
  try {
    const np = notepadFile(sessionId);
    if (fs.existsSync(np)) { const c = fs.readFileSync(np, 'utf8').trim(); if (c) notepad = c.slice(0, 3000); }
  } catch { /* ignore */ }

  const parts: string[] = [];
  parts.push(`# Handoff — continuing work in ${projectName}`);
  parts.push(`This continues an earlier ${vendor} conversation (session \`${sessionId}\`). To pull more detail, use the cldctrl \`search_conversations\` MCP tool (searches across all agents)${vendor === 'claude' ? ' or `read_session` (Claude sessions)' : ''} if available.`);
  if (goal) parts.push(`\n## Original goal\n${goal}`);
  if (gitLine) parts.push(`\n## Current state\n${gitLine}`);
  if (touched.length) parts.push(`\n## Files worked on\n${touched.map((f) => '- ' + f).join('\n')}`);
  if (commits) parts.push(`\n## Recent commits\n${commits}`);
  if (notepad) parts.push(`\n## Notepad (shared draft)\n${notepad}`);
  if (tail) parts.push(`\n## Recent conversation\n${tail}`);
  parts.push(`\n---\nPlease get oriented from the above (and the repo itself), then continue the work. Confirm your understanding before making changes.`);

  let brief = parts.join('\n');
  if (brief.length > BRIEF_CAP) brief = brief.slice(0, BRIEF_CAP) + '\n…(truncated — read the notepad / prior session for the rest)';
  return { ok: true, sessionId, projectPath: cwd || undefined, project: projectName, vendor, brief };
}
