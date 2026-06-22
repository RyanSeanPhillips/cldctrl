/** Fetch wrappers for the dashboard API. */
import type {
  OverviewPayload, TranscriptEntry,
  ProjectCommit, ProjectIssue, ProjectSessionRow, FileEntry, ProjectActivity, SearchResult,
} from './types.js';

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
