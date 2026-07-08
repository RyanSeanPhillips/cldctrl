/**
 * Git worktree helpers for cockpit session isolation. A worktree is a second
 * working copy of a repo on its own branch, so parallel agents can edit without
 * colliding — changes stay on the branch until merged. Created under
 * <project>/.claude/worktrees/<branch-slug> (mirrors the Claude Code desktop
 * convention; git excludes registered worktree dirs from the parent's status).
 */
import spawn from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, out, err: 'timeout' }); }, 20_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
  });
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const r = await git(['-C', projectPath, 'rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out.trim() === 'true';
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
}

/** Keep worktree dirs out of `git status` via the repo-LOCAL exclude file
 *  (never touches the committed .gitignore). */
async function ensureExcluded(projectPath: string): Promise<void> {
  try {
    const r = await git(['-C', projectPath, 'rev-parse', '--git-common-dir']);
    const gitDir = r.ok ? path.resolve(projectPath, r.out.trim()) : path.join(projectPath, '.git');
    const ex = path.join(gitDir, 'info', 'exclude');
    let content = '';
    try { content = fs.readFileSync(ex, 'utf-8'); } catch { /* none yet */ }
    if (!content.split('\n').some((l) => l.trim() === '.claude/worktrees/')) {
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      fs.appendFileSync(ex, (content && !content.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
    }
  } catch { /* best effort */ }
}

export interface WorktreeResult { path: string; branch: string; created: boolean; }

/**
 * Create (or reuse) a worktree on branch `branch` under the project's
 * .claude/worktrees/. Returns null if the project isn't a git repo or git fails.
 */
export async function createWorktree(projectPath: string, branch: string): Promise<WorktreeResult | null> {
  if (!(await isGitRepo(projectPath))) return null;
  await ensureExcluded(projectPath);
  // Reject anything that isn't a plain branch name — a leading '-' or other
  // dashed token would be parsed by git as an option (arg injection) in the
  // fallback `worktree add <path> <ref>` below. Fall back to a safe default.
  const raw = (branch || '').trim();
  const b = /^[A-Za-z0-9._/-]+$/.test(raw) && !raw.startsWith('-') && !raw.startsWith('/')
    ? raw
    : 'cockpit/session';
  const wtRoot = path.join(projectPath, '.claude', 'worktrees');
  try { fs.mkdirSync(wtRoot, { recursive: true }); } catch { /* ignore */ }
  const wtPath = path.join(wtRoot, slug(b));

  if (fs.existsSync(wtPath)) return { path: wtPath, branch: b, created: false };

  // New branch from current HEAD; if the branch already exists, check it out.
  let r = await git(['-C', projectPath, 'worktree', 'add', '-b', b, wtPath]);
  if (!r.ok) {
    const r2 = await git(['-C', projectPath, 'worktree', 'add', wtPath, b]);
    if (!r2.ok) { log('error', { function: 'createWorktree', message: (r.err + ' | ' + r2.err).slice(0, 200) }); return null; }
  }
  log('serve_worktree', { event: 'create', branch: b });
  return { path: wtPath, branch: b, created: true };
}

export async function listWorktrees(projectPath: string): Promise<Array<{ path: string; branch: string }>> {
  const r = await git(['-C', projectPath, 'worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out: Array<{ path: string; branch: string }> = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim() };
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (line.trim() === '' && cur.path) { out.push({ path: cur.path, branch: cur.branch ?? '' }); cur = {}; }
  }
  if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? '' });
  return out;
}

export async function removeWorktree(projectPath: string, wtPath: string): Promise<boolean> {
  const r = await git(['-C', projectPath, 'worktree', 'remove', '--force', wtPath]);
  log('serve_worktree', { event: 'remove', ok: r.ok });
  return r.ok;
}
