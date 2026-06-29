/**
 * Lightweight git backup for notes — version history without a new dependency.
 *
 * The scratch dir (where notepads/scratchpads live) is lazily made into a git repo;
 * saves are committed on a throttle so there's a recoverable history. Reuses
 * cross-spawn (same as core/git.ts); quietly disables itself if git isn't available.
 * There's no UI — `git -C <scratchDir> log` (or a future History view) is the history.
 *
 * Notes: a synthetic author is used and signing is disabled FOR THIS INTERNAL BACKUP
 * REPO ONLY (it's a private, unattended committer under %APPDATA% — not the user's
 * project), so a global commit.gpgsign / missing identity can't hang or fail it.
 */
import spawn from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir, isScratchPath } from './dashboard-bridge.js';

const MIN_INTERVAL_MS = 20_000; // at most one commit per ~20s (immediate when idle)
let inited: boolean | null = null; // null = unknown, false = git unavailable → disabled
let lastCommit = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('git ' + (args[0] ?? '') + ' exit ' + code))));
  });
}

/** Like runGit but captures stdout (for log/show reads). */
function runGitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let out = '', err = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('git ' + (args[0] ?? '') + ' exit ' + code + ': ' + err.trim()))));
  });
}

async function ensureRepo(): Promise<boolean> {
  if (inited !== null) return inited;
  try {
    const dir = scratchDir(); // also creates the dir
    if (!fs.existsSync(path.join(dir, '.git'))) await runGit(['init', '-q'], dir);
    inited = true;
  } catch { inited = false; } // git missing / init failed → stay disabled, quietly
  return inited;
}

async function doCommit(): Promise<void> {
  if (!(await ensureRepo())) return;
  const dir = scratchDir();
  try {
    await runGit(['add', '-A'], dir);
    // `commit` exits non-zero when there's nothing staged — caught and ignored below.
    await runGit(
      ['-c', 'user.name=cldctrl', '-c', 'user.email=cldctrl@localhost', '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', 'notes: snapshot ' + new Date().toISOString()],
      dir,
    );
  } catch { /* nothing to commit / transient git error — non-fatal */ }
}

/**
 * Schedule a throttled notes commit: at most one per ~20s, but immediate when idle.
 * Coalesces a burst of saves into a single snapshot. Safe to call very often.
 */
export function commitNotesSoon(): void {
  if (timer) return; // a commit is already scheduled — this save rides along with it
  const delay = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCommit));
  timer = setTimeout(() => {
    timer = null;
    lastCommit = Date.now();
    void doCommit();
  }, delay);
  timer.unref?.(); // don't keep the process alive for a pending snapshot
}

// ── history & restore ────────────────────────────────────────
export interface NoteRevision { hash: string; date: string; subject: string; }

/** Commit history for one note file (newest first). [] if not versioned / no git. */
export async function noteHistory(filePath: string, limit = 30): Promise<NoteRevision[]> {
  if (!isScratchPath(filePath) || !(await ensureRepo())) return [];
  const rel = path.basename(filePath);
  try {
    const out = await runGitOut(['log', '-n', String(limit), '--format=%H%x09%cI%x09%s', '--', rel], scratchDir());
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash, date, ...rest] = line.split('\t');
      return { hash, date, subject: rest.join('\t') };
    });
  } catch { return []; }
}

/** Content of a note at a specific commit. null if unavailable. `rev` must be a hash. */
export async function noteRevisionContent(filePath: string, rev: string): Promise<string | null> {
  if (!isScratchPath(filePath) || !/^[0-9a-fA-F]{4,40}$/.test(rev) || !(await ensureRepo())) return null;
  try {
    return await runGitOut(['show', `${rev}:${path.basename(filePath)}`], scratchDir());
  } catch { return null; }
}

/** Restore a note to a past revision (writes it back, then snapshots the restore). */
export async function restoreNoteRevision(filePath: string, rev: string): Promise<{ ok: boolean; error?: string }> {
  if (!isScratchPath(filePath)) return { ok: false, error: 'not a notes path' };
  const content = await noteRevisionContent(filePath, rev);
  if (content === null) return { ok: false, error: 'revision not found' };
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    commitNotesSoon(); // record the restore as its own snapshot (history stays linear & recoverable)
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}
