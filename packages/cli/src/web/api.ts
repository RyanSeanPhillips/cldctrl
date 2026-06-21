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
