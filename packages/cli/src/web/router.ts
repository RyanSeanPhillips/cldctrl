/**
 * Minimal hash router. Persists the routable UI state so a reload / bookmark /
 * second tab restores the same view:
 *   #/                          → conversations
 *   #/s/<sessionId>             → conversations, a session expanded
 *   #/p/<encodedPath>           → project detail (default tab)
 *   #/p/<encodedPath>/<tab>     → project detail, specific tab
 */
import { setUi, getState } from './store.js';
import type { DetailTab } from './types.js';

const SAFE_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const TABS: DetailTab[] = ['sessions', 'commits', 'issues', 'files'];

let onChange: (() => void) | null = null;

export function readHash(): void {
  const raw = location.hash.replace(/^#/, '');
  const pathPart = raw.split('?')[0];
  const segs = pathPart.split('/').filter(Boolean);

  let expandedSessionId: string | null = null;
  let selectedProject: string | null = null;
  let detailTab: DetailTab = getState().ui.detailTab;

  if (segs[0] === 's' && segs[1] && SAFE_ID.test(segs[1])) {
    expandedSessionId = segs[1];
  } else if (segs[0] === 'p' && segs[1]) {
    try { selectedProject = decodeURIComponent(segs[1]); } catch { selectedProject = null; }
    if (segs[2] && (TABS as string[]).includes(segs[2])) detailTab = segs[2] as DetailTab;
  }

  setUi({ expandedSessionId, selectedProject, detailTab });
}

export function writeHash(): void {
  const { ui } = getState();
  let h = '#/';
  if (ui.selectedProject) h += 'p/' + encodeURIComponent(ui.selectedProject) + '/' + ui.detailTab;
  else if (ui.expandedSessionId) h += 's/' + ui.expandedSessionId;
  if (h !== location.hash) history.replaceState(null, '', h);
}

export function initRouter(changeCb: () => void): void {
  onChange = changeCb;
  readHash();
  window.addEventListener('hashchange', () => { readHash(); onChange?.(); });
}
