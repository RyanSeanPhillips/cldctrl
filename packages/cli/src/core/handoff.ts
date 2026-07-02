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
  vendor?: 'claude';
  brief?: string;
  error?: string;
}

/** Locate a Claude session's JSONL by id + return its project cwd. */
function resolveClaudeSession(sessionId: string): { file: string; cwd: string } | null {
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
  const resolved = resolveClaudeSession(sessionId);
  if (!resolved) {
    return { ok: false, error: 'Session not found among Claude sessions. Cross-vendor (Codex) handoff is a later slice.' };
  }
  const { file, cwd } = resolved;
  const projectName = cwd ? (cwd.split(/[/\\]/).filter(Boolean).pop() || cwd) : 'this project';

  // Goal = the first user turn; recent context = the transcript tail.
  let goal = '', tail = '';
  try {
    const full = extractTranscript(file, 24);
    tail = full;
    const firstUser = full.match(/(?:^|\n)(?:User|Human)[:>]\s*([\s\S]*?)(?:\n(?:Assistant|Claude)[:>]|\n\n|$)/i);
    if (firstUser) goal = firstUser[1].trim().slice(0, 400);
  } catch { /* transcript optional */ }

  // Files the session touched (from the activity parser, not a noisy git diff).
  let touched: string[] = [];
  try {
    const act = await parseSessionActivity(file);
    if (act?.touchedFiles?.length) {
      touched = act.touchedFiles.filter((t) => t.writes > 0).slice(0, 20).map((t) => t.path);
      if (!touched.length) touched = act.touchedFiles.slice(0, 12).map((t) => t.path);
    }
  } catch { /* activity optional */ }

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
  parts.push(`This continues an earlier conversation (session \`${sessionId}\`). You can pull more detail from it with the cldctrl \`read_session\` / \`search_conversations\` MCP tools if available.`);
  if (goal) parts.push(`\n## Original goal\n${goal}`);
  if (gitLine) parts.push(`\n## Current state\n${gitLine}`);
  if (touched.length) parts.push(`\n## Files worked on\n${touched.map((f) => '- ' + f).join('\n')}`);
  if (commits) parts.push(`\n## Recent commits\n${commits}`);
  if (notepad) parts.push(`\n## Notepad (shared draft)\n${notepad}`);
  if (tail) parts.push(`\n## Recent conversation\n${tail}`);
  parts.push(`\n---\nPlease get oriented from the above (and the repo itself), then continue the work. Confirm your understanding before making changes.`);

  let brief = parts.join('\n');
  if (brief.length > BRIEF_CAP) brief = brief.slice(0, BRIEF_CAP) + '\n…(truncated — read the notepad / prior session for the rest)';
  return { ok: true, sessionId, projectPath: cwd || undefined, project: projectName, vendor: 'claude', brief };
}
