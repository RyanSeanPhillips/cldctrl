/** Fetch wrappers for the dashboard API. */
import type {
  OverviewPayload, TranscriptEntry,
  ProjectCommit, ProjectIssue, ProjectSessionRow, FileEntry, ProjectActivity, SearchResult, StatsPayload, NoteEntry,
} from './types.js';
export type { NoteEntry } from './types.js';

export async function fetchOverview(): Promise<OverviewPayload> {
  const r = await fetch('/api/overview');
  if (!r.ok) throw new Error('overview ' + r.status);
  return r.json();
}

export async function fetchTranscript(id: string): Promise<TranscriptEntry[]> {
  const r = await fetch('/api/transcript?id=' + encodeURIComponent(id));
  if (!r.ok) throw new Error('transcript ' + r.status);
  const d = await r.json();
  return d.entries ?? [];
}

export interface LaunchResult {
  success?: boolean;
  message?: string;
  project?: string;
  error?: string;
}

/** POST a write action. The X-CLDCTRL header forces a CORS preflight that
 *  cross-origin pages can't pass — the server's CSRF guard. */
export async function postLaunch(body: { path: string; prompt?: string; resume?: string }): Promise<LaunchResult> {
  const r = await fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── project detail tabs ──────────────────────────────────────
async function projectGet(tab: string, projectPath: string, extra = ''): Promise<any> {
  const r = await fetch('/api/project/' + tab + '?path=' + encodeURIComponent(projectPath) + extra);
  if (!r.ok) throw new Error(tab + ' ' + r.status);
  return r.json();
}

export async function fetchProjectSessions(p: string): Promise<ProjectSessionRow[]> {
  return (await projectGet('sessions', p)).sessions ?? [];
}
export async function fetchProjectCommits(p: string): Promise<ProjectCommit[]> {
  return (await projectGet('commits', p)).commits ?? [];
}
export async function fetchProjectIssues(p: string): Promise<{ issues: ProjectIssue[]; ghAvailable: boolean; installUrl?: string }> {
  return projectGet('issues', p);
}
export async function fetchProjectFiles(p: string, dir: string): Promise<{ dir: string; nodes: FileEntry[] }> {
  return projectGet('files', p, '&dir=' + encodeURIComponent(dir));
}
export async function fetchProjectActivity(p: string): Promise<ProjectActivity> {
  return projectGet('activity', p);
}

export async function fetchStats(days: number): Promise<StatsPayload> {
  const r = await fetch('/api/stats?days=' + days);
  if (!r.ok) throw new Error('stats ' + r.status);
  return r.json();
}

/** Lazy-load the images for one (session, hour-bucket) when a marker is clicked. */
export async function fetchBucketImages(slug: string, session: string, t: number): Promise<string[]> {
  const r = await fetch('/api/conversation-image?slug=' + encodeURIComponent(slug) + '&session=' + encodeURIComponent(session) + '&t=' + t);
  if (!r.ok) return [];
  return (await r.json()).images ?? [];
}

export async function fetchSearch(q: string): Promise<SearchResult[]> {
  const r = await fetch('/api/search?q=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('search ' + r.status);
  return (await r.json()).results ?? [];
}

/** Read a file (for cockpit doc tiles). */
export async function fetchFile(p: string): Promise<{ content: string; mtime: number } | null> {
  const r = await fetch('/api/file?path=' + encodeURIComponent(p));
  if (!r.ok) return null;
  return r.json();
}

/** Write a file (for cockpit doc tiles). */
export async function postFile(p: string, content: string): Promise<{ ok?: boolean; mtime?: number; error?: string }> {
  const r = await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ path: p, content }),
  });
  return r.json();
}

/** Open a project's location on disk: the system file explorer or VS Code. */
export async function postReveal(path: string, target: 'explorer' | 'code' | 'default'): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ path, target }),
  });
  return r.json();
}

/** Build a handoff brief from a conversation's on-disk state (transcript tail,
 *  touched files, git status, notepad) so its work can continue on another agent
 *  — works even when the original agent is dead. Returns the brief + resolved
 *  project so the caller can open a new sibling tile prefilled with it. */
export async function postHandoffBrief(session: string): Promise<{ ok?: boolean; sessionId?: string; projectPath?: string; project?: string; vendor?: string; brief?: string; error?: string }> {
  const r = await fetch('/api/handoff-brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ session }),
  });
  return r.json();
}

/** Convert a markdown note to LaTeX server-side (pandoc). pandocMissing:true
 *  means the machine has no pandoc — the caller falls back to asking the
 *  conversation's agent to write the .tex instead. */
export async function postLatexConvert(path: string): Promise<{ ok?: boolean; texPath?: string; pandocMissing?: boolean; error?: string }> {
  const r = await fetch('/api/latex-convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ path }),
  });
  return r.json();
}

/** Pop a conversation out into its own chromeless app window. The server
 *  validates the tile, builds the widget URL, and opens it via launchAppWindow;
 *  with no Chromium available it replies { fallback, url } so the client can
 *  window.open() a plain popup instead. */
export async function postPopout(body: { kind: 'resume' | 'new'; id?: string; session: string; path: string; title: string; agent?: string; vendor?: string }): Promise<{ ok?: boolean; fallback?: boolean; url?: string; error?: string }> {
  const r = await fetch('/api/popout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify(body),
  });
  return r.json();
}

/** Resolve (creating if needed) a STABLE per-conversation notepad path keyed by
 *  the conversation, so the docked notepad reopens the same draft on resume. The
 *  project/conversation association lets it surface in the project's notes list. */
export async function postNotepad(key: string, project?: string, conversation?: string): Promise<{ ok?: boolean; path?: string; error?: string }> {
  const r = await fetch('/api/scratch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ key, project, conversation }),
  });
  return r.json();
}

/** Mint an ADDITIONAL fresh note for a conversation ("+ New note"). */
export async function postNewNote(project: string, conversation: string, title?: string): Promise<{ ok?: boolean; path?: string; error?: string }> {
  const r = await fetch('/api/notes/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ project, conversation, title }),
  });
  return r.json();
}

export interface NoteRevision { hash: string; date: string; subject: string; }

/** Git history (newest-first) for one note file. */
export async function fetchNoteHistory(path: string): Promise<NoteRevision[]> {
  try {
    const r = await fetch('/api/notes/history?path=' + encodeURIComponent(path));
    const j = await r.json();
    return Array.isArray(j.revisions) ? j.revisions : [];
  } catch { return []; }
}

/** Restore a note to a past revision (hash). */
export async function postRestoreNote(path: string, rev: string): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch('/api/notes/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
      body: JSON.stringify({ path, rev }),
    });
    return r.json();
  } catch { return { ok: false, error: 'request failed' }; }
}

/** Associate an existing note file with a conversation/project (e.g. an agent
 *  scratchpad adopted as a conversation's notepad) so it surfaces in the list. */
export async function postRecordNote(path: string, project: string, conversation: string): Promise<void> {
  try {
    await fetch('/api/notes/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
      body: JSON.stringify({ path, project, conversation }),
    });
  } catch { /* best-effort */ }
}

/** List notes, scoped to a project and/or conversation (omit for all), optionally
 *  full-text filtered by `query` (matches note titles and bodies, server-side). */
export async function fetchNotes(opts?: { project?: string; conversation?: string; query?: string }): Promise<NoteEntry[]> {
  const qs = new URLSearchParams();
  if (opts?.project) qs.set('project', opts.project);
  if (opts?.conversation) qs.set('conversation', opts.conversation);
  if (opts?.query) qs.set('q', opts.query);
  try {
    const r = await fetch('/api/notes?' + qs.toString());
    const j = await r.json();
    return Array.isArray(j.notes) ? j.notes : [];
  } catch { return []; }
}

/** Capture a screenshot and have the server type its path into a terminal. */
export async function postScreenshot(target: string, mode: 'region' | 'full' = 'region'): Promise<{ path?: string; error?: string }> {
  const r = await fetch('/api/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
    body: JSON.stringify({ target, mode }),
  });
  return r.json();
}

/** Publish what the user is searching/viewing so the control-plane agent can read it. */
export async function postBridge(query: string, selectedProject: string | null): Promise<void> {
  try {
    await fetch('/api/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CLDCTRL': '1' },
      body: JSON.stringify({ query, selectedProject }),
    });
  } catch { /* best-effort */ }
}
