/** All dashboard views, rendered declaratively with uhtml from store state. */
import { html, svg } from 'uhtml';
import type { OverviewPayload, SessionInfo, ProjectInfo, UsageWindow, HeatCell } from './types.js';
import type { State, RestoreItem, RestoreOffer } from './store.js';
import { tok, ago, clamp } from './util.js';
import { THEMES, currentTheme } from './theme.js';

/** Anything `html\`\`` can return (a rendered node or a Tpl placeholder). */
type Tpl = ReturnType<typeof html>;

// ── icons (inline SVG, currentColor) ─────────────────────────
const svgWrap = (path: Tpl) => svg`<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const iPlay = () => svgWrap(svg`<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"></polygon>`);
const iTerminal = () => svgWrap(svg`<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>`);
const iBranch = () => svgWrap(svg`<circle cx="6" cy="6" r="2.4"></circle><circle cx="6" cy="18" r="2.4"></circle><circle cx="18" cy="7" r="2.4"></circle><path d="M6 8.4v7.2M8.4 6.4H14a3 3 0 0 1 3 3v0"></path>`);
const iGrid = () => svgWrap(svg`<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect>`);
const iSearch = () => svgWrap(svg`<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>`);
const iStats = () => svgWrap(svg`<line x1="6" y1="20" x2="6" y2="11"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="18" y1="20" x2="18" y2="14"></line>`);
const iNote = () => svgWrap(svg`<path d="M5 3h9l5 5v13H5z"></path><polyline points="14 3 14 8 19 8"></polyline><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="13" y2="17"></line>`);
const iAdd = () => svgWrap(svg`<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>`);
const iHeadphones = () => svgWrap(svg`<path d="M4 14v-2a8 8 0 0 1 16 0v2"></path><rect x="2.5" y="14" width="5" height="7" rx="1.5"></rect><rect x="16.5" y="14" width="5" height="7" rx="1.5"></rect>`);
const iUp = () => svgWrap(svg`<line x1="12" y1="19" x2="12" y2="5"></line><polyline points="6 11 12 5 18 11"></polyline>`);
const iCols1 = () => svgWrap(svg`<rect x="4" y="4" width="16" height="16" rx="1"></rect>`);
const iCols2 = () => svgWrap(svg`<rect x="4" y="4" width="7" height="16" rx="1"></rect><rect x="13" y="4" width="7" height="16" rx="1"></rect>`);

/** Resume a conversation as a live tile in the web cockpit (the in-app surface). */
function cockpitBtn(sessionId: string, projectPath: string, title: string): Tpl {
  return html`<button class="btn primary" data-act="openincockpit" data-id=${sessionId} data-path=${projectPath} data-title=${title}
    title="Resume this conversation here">${iGrid()} Resume here</button>`;
}

/** A small per-vendor badge so cross-vendor search results read at a glance which
 *  CLI a session came from. Only shown for non-Claude (Claude is the default). */
function vendorChip(vendor?: 'claude' | 'codex'): Tpl | string {
  if (!vendor || vendor === 'claude') return '';
  return html`<span class=${'vendor-chip ' + vendor} title=${'From the ' + vendor + ' CLI'}>${vendor}</span>`;
}

// ── small viz helpers ────────────────────────────────────────
function heatLevel(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  // Perceptual (sqrt) scale: a single huge day otherwise flattens every other
  // day to the faintest level and the grid reads as empty/broken.
  const r = Math.sqrt(v / max);
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}

function heatmap(daily: HeatCell[], kind: 'tok' | 'com'): Tpl {
  if (!daily.length) return html`<div class="empty">No activity.</div>`;
  const max = Math.max(...daily.map((d) => d.value));
  const firstDow = new Date(daily[0].date + 'T00:00:00').getDay();
  const pads: Tpl[] = [];
  for (let i = 0; i < firstDow; i++) pads.push(html`<div class="cell pad"></div>`);
  const cells = daily.map((d) => {
    const lvl = heatLevel(d.value, max);
    const label = kind === 'tok' ? tok(d.value) + ' tok' : d.value + (d.value === 1 ? ' commit' : ' commits');
    return html`<div class="cell" title=${d.date + ': ' + label} style=${'background:var(--heat-' + kind + '-' + lvl + ')'}></div>`;
  });
  return html`<div class="heat">${pads}${cells}</div>`;
}

function usageBar(w: UsageWindow): Tpl {
  const pct = w.percent;
  const shown = pct === null ? 0 : clamp(pct, 0, 100);
  const cls = shown > 90 ? 'crit' : shown > 70 ? 'warn' : '';
  const val = pct === null
    ? html`<span class="num">${tok(w.tokens)}</span> <small>est</small>`
    : html`<span class="num">${pct}%</span>${w.resetIn ? html` <small>· ${w.resetIn}</small>` : ''}`;
  return html`<div class="bar"><div class=${cls} style=${'width:' + shown + '%'}><span class="cap"></span></div></div>
    <span class="bar-val">${val}</span>`;
}

// Sidebar-footer controls (moved out of the top-right so the topbar stays clean
// and the sidebar is a self-contained unit — the basis for the future widget):
// a compact theme dropdown + the listen-mode toggle.
function sideControls(): Tpl {
  const cur = currentTheme();
  return html`<div class="side-controls">
    <select class="theme-select" data-act="theme-select" title="Theme" aria-label="Theme">
      ${THEMES.map((t) => html`<option value=${t.id} ?selected=${cur === t.id}>${t.label}</option>`)}
    </select>
    <button class="btn icon hands-free" data-act="handsfree-toggle" title="Listen mode — auto-read new replies aloud; Bluetooth/media buttons play/stop/replay">${iHeadphones()}</button>
    <button class="btn icon power-btn" data-act="power-menu" title="Restart or stop the dashboard server">⏻</button>
  </div>`;
}

// ── topbar (brand · live count · theme · listen) ──
// Usage bars moved OUT of here into the sidebar's fixed-bottom zone. Search is now
// in the sidebar too. CTRL is now a pinned row in the sidebar conversations list
// (opens an on-demand cockpit tile) — the old topbar/dock toggle is retired.
// "Update available" pill — shown when the server reports a newer published
// version and the user hasn't dismissed THAT version. Dismissal persists in
// localStorage (the 3s poll re-renders the tree, so a class toggle wouldn't
// stick — same lesson as the search-open state).
function updatePill(d: OverviewPayload): Tpl | string {
  const v = d.updateAvailable;
  if (!v) return '';
  let dismissed = '';
  try { dismissed = localStorage.getItem('cldctrl-dismissed-update') || ''; } catch { /* ignore */ }
  if (dismissed === v) return '';
  // NB: build the title in JS — a µhtml template hole embedded *inside* a quoted
  // attribute string (text before AND after ${...}) mis-parses and leaks into
  // visible content; a whole-value hole (title=${str}) is required.
  const tip = `A newer cldctrl (v${v}) is available — click to copy the update command`;
  return html`<span class="update-pill" data-act="update-open" title=${tip}>
    ${iUp()}<span class="up-ver">v${v}</span>
    <button class="update-x" data-act="update-dismiss" data-ver=${v} title="Dismiss until the next release" aria-label="Dismiss">✕</button>
  </span>`;
}

// "Restart to load" pill — a NEWER LOCAL BUILD is on disk than the one this
// server is running (rebuilt while up). Distinct from updatePill (a newer
// PUBLISHED release). Clicking copies `cc restart`; the ⏻ power menu offers a
// one-click restart. Not dismissable — it clears itself once you actually
// restart (the new server's buildId matches disk again).
function restartPill(d: OverviewPayload): Tpl | string {
  if (!d.buildUpdateReady) return '';
  return html`<span class="update-pill restart-pill" data-act="restart-open"
    title="A newer build is on disk — restart the dashboard to load it (copies \`cc restart\`)">
    ${iUp()}<span class="up-ver">restart to load</span>
  </span>`;
}


// ── sidebar (projects) ───────────────────────────────────────
function gitBadge(p: ProjectInfo): Tpl | string {
  if (!p.branch && !p.dirty && !p.ahead) return '';
  return html`<span class="git">${iBranch()}<span class="num">${p.branch ?? ''}</span>${
    p.dirty ? html` <span class="dirty num">+${p.dirty}</span>` : ''}${
    p.ahead ? html` <span class="ahead num">↑${p.ahead}</span>` : ''}</span>`;
}

const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

function projectRow(p: ProjectInfo, ui: State['ui'], matchPaths: Set<string> | null): Tpl {
  const selected = ui.selectedProject === p.path;
  const dotCls = p.active ? 'dot active' : 'dot';
  let mark = '';
  if (matchPaths) mark = matchPaths.has(normPath(p.path)) ? ' match' : ' dim';
  return html`<div class=${'proj-row' + (selected ? ' selected' : '') + (p.active ? ' active-proj' : '') + mark} data-act="selectproject" data-path=${p.path}>
    <span class=${dotCls}></span>
    <span class="proj-name">${p.name}</span>
    ${gitBadge(p)}
  </div>`;
}

// Sidebar group order: known groups first (per PROJECT_GROUP_ORDER), then any
// custom group names alphabetically, with Ungrouped always last.
const GROUP_ORDER = ['Apps', 'Research', 'Professional', 'Exploring', 'Ungrouped'];
function orderedGroups(names: Set<string>): string[] {
  const known = GROUP_ORDER.filter((g) => names.has(g) && g !== 'Ungrouped');
  const custom = [...names].filter((g) => !GROUP_ORDER.includes(g)).sort();
  const tail = names.has('Ungrouped') ? ['Ungrouped'] : [];
  return [...known, ...custom, ...tail];
}

function projectGroupSection(group: string, projects: ProjectInfo[], ui: State['ui'], matchPaths: Set<string> | null): Tpl {
  const collapsed = ui.collapsedGroups.includes(group);
  const liveCount = projects.filter((p) => p.active).length;
  return html`<div class=${'proj-group' + (collapsed ? ' collapsed' : '')}>
    <div class="group-head" data-act="toggle-group" data-group=${group}>
      <span class="group-caret">${collapsed ? '▸' : '▾'}</span>
      <span class="group-name">${group}</span>
      <span class="group-count num">${projects.length}</span>
      ${liveCount ? html`<span class="group-live"><span class="dot active"></span>${liveCount}</span>` : ''}
    </div>
    ${collapsed ? '' : html`<div class="proj-list">${projects.map((p) => projectRow(p, ui, matchPaths))}</div>`}
  </div>`;
}

// Per-agent vendor mark: a small rounded badge before the conversation name so
// each row reads at a glance which CLI it belongs to. Claude is the default (the
// server doesn't populate `vendor` yet — forward-scaffolding).
const VENDOR_MARK: Record<string, [cls: string, glyph: string]> = {
  claude: ['v-claude', '✻'],
  codex: ['v-codex', '⬡'],
  antigravity: ['v-anti', '✦'],
  gemini: ['v-anti', '✦'],
};
function vendorMark(vendor?: string): Tpl {
  const [cls, glyph] = VENDOR_MARK[vendor || 'claude'] || VENDOR_MARK.claude;
  return html`<span class=${'side-vmark ' + cls}>${glyph}</span>`;
}

// One row in the sidebar Conversations list (Live, then dimmed Recent). Clickable
// rows (with an id) resume the conversation as a cockpit tile. Layout left→right:
// [status dot] [vendor badge] [name + current-action] [when].
function sideConvItem(s: SessionInfo): Tpl {
  const cls = s.status === 'active' ? 'active' : 'idle';
  const act = s.currentAction || (s.status === 'active' ? 'working…' : 'idle');
  const inner = html`
    <span class=${'dot ' + s.status}></span>
    ${vendorMark(s.vendor)}
    <div class="side-conv-main">
      <div class="side-conv-nm">${s.project}</div>
      <div class="side-conv-act">${act}</div>
    </div>
    <span class="side-conv-when">${ago(s.lastActivity)}</span>`;
  return s.id
    ? html`<div class=${'side-conv ' + cls} data-act="openincockpit" data-id=${s.id} data-path=${s.path} data-title=${s.project} data-vendor=${s.vendor || 'claude'}
        title="Resume this conversation">${inner}</div>`
    : html`<div class=${'side-conv ' + cls}>${inner}</div>`;
}

// The CTRL mission-control agent — a SUBTLE pinned entry at the top of the
// conversations list (a quiet ◆ vendor-mark, not the old orange banner).
// ON-DEMAND: clicking it opens a kind:'control' cockpit tile (which is when
// `claude --continue` spawns); it doesn't auto-spawn on load.
function ctrlRow(d: OverviewPayload, state: State): Tpl | string {
  if (!d.features.agentTerminal) return '';
  const cp = state.ui.cockpit;
  const open = cp.tiles.some((t) => t.kind === 'control');
  const waiting = (cp.attnTiles ?? []).includes('control');
  return html`<div class=${'side-ctrl-row' + (open || waiting ? ' active' : '')} data-act="open-control"
    title="CTRL — mission-control agent (opens as a tile)">
    <span class="side-vmark v-ctrl">◆</span>
    <span class="side-ctrl-nm">CTRL</span>
    <span class=${'side-ctrl-tag' + (waiting ? ' waiting' : '')}>${
      waiting ? '⚠ waiting' : open ? 'open' : 'mission control'}</span>
  </div>`;
}

// A COMPACT recent (idle) row: vendor mark + name + when only — no status dot
// and no current-action subtitle (those are reserved for LIVE rows). Single line.
function sideRecentItem(s: SessionInfo): Tpl {
  const inner = html`${vendorMark(s.vendor)}
    <span class="side-recent-nm">${s.project}</span>
    <span class="side-recent-when">${ago(s.lastActivity)}</span>`;
  return s.id
    ? html`<div class="side-recent-row" data-act="openincockpit" data-id=${s.id} data-path=${s.path} data-title=${s.project} data-vendor=${s.vendor || 'claude'}
        title="Resume this conversation">${inner}</div>`
    : html`<div class="side-recent-row">${inner}</div>`;
}

function sideConversations(d: OverviewPayload, state: State): Tpl {
  const liveS = d.sessions.filter((s) => s.status === 'active');
  const recent = d.sessions.filter((s) => s.status !== 'active');
  const recentCollapsed = state.ui.recentCollapsed;
  return html`${ctrlRow(d, state)}
    <div class="side-live-list">
      ${d.sessions.length
        ? html`${liveS.map(sideConvItem)}${recent.length ? html`
            <div class="side-sub-lbl side-recent-lbl" data-act="toggle-recent" title="Show/hide recent conversations">
              <span class="side-recent-caret">${recentCollapsed ? '▸' : '▾'}</span><span>Recent</span><span class="side-recent-n num">${recent.length}</span>
            </div>${recentCollapsed ? '' : recent.map(sideRecentItem)}` : ''}`
        : html`<div class="empty">No sessions in the last 5h.</div>`}
    </div>`;
}

// Compact usage telemetry — replaces the old topbar bars and the idea of a
// full-width bottom status bar. Pinned to the sidebar's fixed-bottom zone.
function sideUsage(d: OverviewPayload, statsActive: boolean): Tpl {
  return html`<div class="side-usage">
    <div class="side-usage-line">
      <span class="side-usage-tierwrap">
        ${d.tier ? html`<span class="side-usage-tier">◆ ${d.tier}</span>` : ''}
        ${d.version ? html`<span class="side-usage-ver num" title=${'cldctrl v' + d.version + ' · updated ' + new Date(d.generatedAt).toLocaleTimeString()}>v${d.version}</span>` : ''}
      </span>
      ${updatePill(d)}
      ${restartPill(d)}
      <span class="sp"></span>
      <button class=${'side-usage-stats' + (statsActive ? ' nav-on' : '')} data-act="nav-stats" title="Open usage & stats">${iStats()} Stats</button>
    </div>
    <div class="side-usage-row"><span class="side-usage-lbl" title="Claude 5-hour rolling window">5h</span>${usageBar(d.usage.fiveHour)}</div>
    <div class="side-usage-row"><span class="side-usage-lbl" title="Claude 7-day rolling window">7d</span>${usageBar(d.usage.sevenDay)}</div>
    ${d.usage.codex ? html`<div class="side-usage-row"><span class="side-usage-lbl vlbl-codex" title="OpenAI Codex rate-limit window">${vendorMark('codex')}</span>${usageBar(d.usage.codex)}</div>` : ''}
    ${d.usage.overage ? html`<div class="side-usage-row overage-row"><span class="side-usage-lbl">extra</span>
      <span class="overage" title=${'Paid overage · resets ' + d.usage.overage.resetIn}>⚠ <span class="num">${d.usage.overage.percent}%</span></span></div>` : ''}
    ${sideControls()}
  </div>`;
}

// App mode (chromeless --app= window / installed PWA) vs a normal browser tab.
// In app mode the OS title bar already shows "CLD CTRL", so the sidebar brand
// drops the wordmark (logo only) to avoid the redundant name right below it.
const IS_APP_MODE = typeof window !== 'undefined' && (
  new URLSearchParams(window.location.search).has('app')          // our --app launcher tags ?app=1
  || (!!window.matchMedia && !window.matchMedia('(display-mode: browser)').matches) // installed PWA
);

function sidebar(d: OverviewPayload, state: State, query: string, matchPaths: Set<string> | null): Tpl {
  const ui = state.ui;
  const searching = !!query.trim();
  const home = !searching && !ui.selectedProject;
  const cockpitActive = home && ui.cockpit.tab !== 'stats';
  const statsActive = home && ui.cockpit.tab === 'stats';
  const searchOpen = ui.searchOpen || searching;
  const live = d.sessions.filter((s) => s.status === 'active').length;
  const names = new Set(d.projects.map((p) => p.group || 'Ungrouped'));
  const groups = orderedGroups(names);
  return html`<aside class="sidebar">
    ${IS_APP_MODE ? '' : html`<div class="side-brand" data-act="nav-cockpit" title="CLD CTRL — go to your conversations">
      <span class="logo" aria-hidden="true"></span>
      <span class="wordmark">CLD CTRL</span>
    </div>`}
    <div class="side-top">
      <div class="side-head-row">
        <div class=${'side-conv-head' + (cockpitActive ? ' nav-on' : '')} data-act="nav-cockpit" title="Click to open your live conversations">
          ${iGrid()}
          <span class="side-conv-head-t">Conversations</span>
          <span class="side-conv-head-live"><span class="dot active"></span>${live} live</span>
        </div>
        <button class=${'side-search-btn' + (searchOpen ? ' on' : '')} data-act="search-toggle" title="Search (/)" aria-label="Search">${iSearch()}</button>
      </div>
      ${searchOpen ? html`<div class="side-search-box">
        <input id="search-input" class="search" placeholder="Search conversations…" .value=${query}>
        ${searching ? html`<button class="search-clear" data-act="searchclear" title="Clear">✕</button>` : ''}
      </div>` : ''}
      <div class="side-conv-actions">
        <button class="btn primary" data-act="cockpit-add-toggle" title="Add a conversation">${iAdd()} Add</button>
        <span class="sp"></span>
        <div class="cp-layouts" title="Cockpit layout">
          <button class=${'btn icon' + (ui.cockpit.layout === 'cols1' ? ' on' : '')} data-act="cockpit-layout" data-layout="cols1" title="Single column">${iCols1()}</button>
          <button class=${'btn icon' + (ui.cockpit.layout === 'cols2' ? ' on' : '')} data-act="cockpit-layout" data-layout="cols2" title="Two columns">${iCols2()}</button>
          <button class=${'btn icon' + (ui.cockpit.layout === 'grid' ? ' on' : '')} data-act="cockpit-layout" data-layout="grid" title="Grid">${iGrid()}</button>
        </div>
      </div>
      ${sideConversations(d, state)}
    </div>
    <div class="side-scroll">
      <div class="side-head">Projects ${matchPaths ? html`<span class="hint">— ${matchPaths.size} in results</span>` : html`<span class="hint">— click to inspect</span>`}</div>
      ${d.projects.length
        ? groups.map((g) => projectGroupSection(g, d.projects.filter((p) => (p.group || 'Ungrouped') === g), ui, matchPaths))
        : html`<div class="empty">No projects. Run a scan in the TUI.</div>`}
    </div>
    ${sideUsage(d, statsActive)}
  </aside>`;
}

// ── transcript (used by the project-detail Sessions tab) ─────
function transcriptView(state: State): Tpl {
  const t = state.transcript;
  if (!t || t.id !== state.ui.expandedSessionId) return html`<div class="empty">Loading…</div>`;
  if (!t.entries.length) return html`<div class="empty">No transcript yet.</div>`;
  return html`${t.entries.map((e) => html`<div class=${'t-' + e.role}>${
    e.role === 'user' ? '❯ ' : e.role === 'tool' ? '⚙ ' : ''}${e.text}</div>`)}`;
}

// ── project detail (tabs: sessions / commits / issues / files) ─
const DETAIL_TABS: Array<{ key: import('./types.js').DetailTab; label: string }> = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'commits', label: 'Commits' },
  { key: 'issues', label: 'Issues' },
  { key: 'files', label: 'Files' },
];

function tabCount(state: State, key: string): number | null {
  const dt = state.detail;
  if (key === 'sessions') return dt.sessions?.length ?? null;
  if (key === 'commits') return dt.commits?.length ?? null;
  if (key === 'issues') return dt.issues?.issues.length ?? null;
  return null;
}

function sessionsTab(state: State, projectPath: string): Tpl {
  const dt = state.detail;
  if (dt.sessions === null) return html`<div class="empty">Loading sessions…</div>`;
  if (!dt.sessions.length) return html`<div class="empty">No recorded sessions for this project.</div>`;
  return html`<div class="dlist">${dt.sessions.map((s) => {
    const expanded = state.ui.expandedSessionId === s.id;
    return html`<div class=${'srow2' + (expanded ? ' expanded' : '')}>
      <div class="drow" data-act="toggle" data-id=${s.id}>
        <div class="drow-main">
          <div class="drow-title">${s.summary}</div>
          <div class="drow-meta">
            <span>${ago(s.modified)}</span>${s.branch ? html`<span class="sep">·</span><span class="num">${s.branch}</span>` : ''}
            <span class="sep">·</span><span class="num">${tok(s.tokens)} tok</span>
            <span class="sep">·</span><span class="num">${s.messages} msgs</span>
            ${s.cost != null ? html`<span class="sep">·</span><span class="num">$${s.cost.toFixed(2)}</span>` : ''}
          </div>
        </div>
        <div class="res-actions">
          ${cockpitBtn(s.id, projectPath, projectPath.split(/[/\\]/).pop() || projectPath)}
          <button class="btn" data-act="resume" data-id=${s.id} data-path=${projectPath} title="Resume in a separate terminal window">${iTerminal()} Resume in terminal</button>
        </div>
      </div>
      ${expanded ? html`<div class="detail">
        ${s.firstPrompt ? html`<div class="first-prompt">❯ ${s.firstPrompt}</div>` : ''}
        <div class="transcript" id="transcript">${transcriptView(state)}</div>
      </div>` : ''}
    </div>`;
  })}</div>`;
}

function activityStrip(state: State): Tpl | string {
  const a = state.detail.activity;
  if (!a) return '';
  const hasCommits = a.commits.some((c) => c.value > 0);
  return html`<div class="detail-activity">
    <div class="heat-wrap"><div class="sub">Tokens · 28d</div>${heatmap(a.tokens, 'tok')}</div>
    ${hasCommits ? html`<div class="heat-wrap"><div class="sub">Commits · 28d</div>${heatmap(a.commits, 'com')}</div>` : ''}
  </div>`;
}

function commitsTab(state: State): Tpl {
  const dt = state.detail;
  if (dt.commits === null) return html`<div class="empty">Loading commits…</div>`;
  if (!dt.commits.length) return html`<div class="empty">No commits found.</div>`;
  return html`<div class="dlist">${dt.commits.map((c) => html`<div class="drow">
    <div class="drow-main">
      <div class="drow-title">${c.subject}</div>
      <div class="drow-meta"><span>${ago(c.date)}</span><span class="sep">·</span><span class="num hash">${c.hash.slice(0, 7)}</span></div>
    </div>
    <div class="diffstat num"><span class="add">+${c.additions}</span> <span class="del">−${c.deletions}</span></div>
  </div>`)}</div>`;
}

function issuesTab(state: State): Tpl {
  const dt = state.detail;
  if (dt.issues === null) return html`<div class="empty">Loading issues…</div>`;
  if (!dt.issues.ghAvailable) {
    return html`<div class="empty">GitHub CLI (<span class="num">gh</span>) not available — issues unavailable.${
      dt.issues.installUrl ? html` <a href=${dt.issues.installUrl} target="_blank" rel="noreferrer">Install</a>` : ''}</div>`;
  }
  if (!dt.issues.issues.length) return html`<div class="empty">No open issues. 🎉</div>`;
  return html`<div class="dlist">${dt.issues.issues.map((i) => html`<div class="drow">
    <div class="drow-main">
      <div class="drow-title"><span class="inum num">#${i.number}</span> ${i.title}</div>
      <div class="drow-meta">
        ${i.author ? html`<span>${i.author}</span><span class="sep">·</span>` : ''}<span>${ago(i.createdAt)}</span>
        ${i.labels.map((l) => html`<span class="label">${l}</span>`)}
      </div>
    </div>
    <a class="btn" href=${i.url} target="_blank" rel="noreferrer">Open</a>
  </div>`)}</div>`;
}

function fileTreeNodes(state: State, dir: string, depth: number): Tpl | string {
  const nodes = state.detail.files[dir];
  if (!nodes) return depth === 0 ? html`<div class="empty">Loading files…</div>` : '';
  if (!nodes.length) return depth === 0 ? html`<div class="empty">Empty directory.</div>` : '';
  const projRoot = (state.ui.selectedProject ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return html`${nodes.map((n) => {
    const isDir = n.type === 'directory';
    const isDoc = !isDir && /\.(md|markdown|txt)$/i.test(n.name);
    const expanded = state.detail.expandedDirs.includes(n.relativePath);
    const docPath = isDoc ? projRoot + '/' + n.relativePath : null;
    return html`<div>
      <div class=${'ft2-row' + (n.isClaude ? ' claude' : '') + (isDir ? ' dir' : '') + (isDoc ? ' doc' : '')}
        style=${'padding-left:' + (depth * 16 + 8) + 'px'}
        data-act=${isDir ? 'expanddir' : isDoc ? 'opendoc' : null} data-dir=${isDir ? n.relativePath : null} data-path=${docPath}>
        <span class="ft2-icon">${isDir ? (expanded ? '▾' : '▸') : n.fileIcon}</span>
        <span class="ft2-name">${n.name}</span>
        ${isDoc ? html`<span class="ft2-open">open ↗</span>` : ''}
        ${isDir && n.childCount != null ? html`<span class="ft2-count num">${n.childCount}</span>` : ''}
      </div>
      ${isDir && expanded ? fileTreeNodes(state, n.relativePath, depth + 1) : ''}
    </div>`;
  })}`;
}

function filesTab(state: State): Tpl {
  return html`<div class="filetree2">${fileTreeNodes(state, '', 0)}</div>`;
}

function detailTabBody(state: State, projectPath: string): Tpl {
  switch (state.ui.detailTab) {
    case 'sessions': return sessionsTab(state, projectPath);
    case 'commits': return commitsTab(state);
    case 'issues': return issuesTab(state);
    case 'files': return filesTab(state);
  }
}

function projectDetail(d: OverviewPayload, state: State): Tpl {
  const projPath = state.ui.selectedProject!;
  const p = d.projects.find((x) => x.path === projPath);
  const name = p ? p.name : projPath.split(/[/\\]/).pop() || projPath;
  const ui = state.ui;
  return html`<section class="card detail-card">
    <div class="detail-top">
      <button class="btn back" data-act="home" title="Back to conversations">‹</button>
      <h2 class="detail-name">${name}</h2>
      ${p ? gitBadge(p) : ''}
      <span class="sp"></span>
      <button class="btn primary" data-act="newcockpit" data-path=${projPath} data-name=${name} title="Start a new conversation here (open several at once)">${iGrid()} New here</button>
      <button class="btn" data-act="newsession" data-path=${projPath} title="Start a new conversation in a separate terminal window">${iTerminal()} New in terminal</button>
    </div>
    ${ui.newSessionOpen ? html`<div class="launch-form detail-launch">
      <input id="newsession-prompt" placeholder="optional prompt…" maxlength="2000" .value=${ui.newSessionDraft}>
      <button class="btn primary" data-act="newlaunch" data-path=${projPath}>Launch</button>
    </div>` : ''}
    ${activityStrip(state)}
    <div class="tabs">
      ${DETAIL_TABS.map((t) => {
        const c = tabCount(state, t.key);
        return html`<button class=${'tab' + (ui.detailTab === t.key ? ' active' : '')} data-act="tab" data-tab=${t.key}>
          ${t.label}${c != null ? html` <span class="tab-count num">${c}</span>` : ''}</button>`;
      })}
    </div>
    ${state.detail.error ? html`<div class="empty err">${state.detail.error}</div>` : detailTabBody(state, projPath)}
  </section>`;
}

function searchView(state: State): Tpl {
  const s = state.search;
  const q = s.query.trim();
  return html`<section class="card">
    <div class="card-head">
      <h2>Search</h2>
      <span class="card-meta">${s.loading ? 'searching…' : s.results.length + ' session' + (s.results.length === 1 ? '' : 's')}</span>
    </div>
    ${s.agentNote !== null ? html`<div class="agent-banner">
      <span class="ab-tag">cldctrl agent</span>${s.agentNote ? html` ${s.agentNote}` : html` showed you these results for “${q}”.`}
    </div>` : ''}
    ${s.results.length === 0
      ? html`<div class="empty">${s.loading ? 'Searching…' : 'No conversations match “' + q + '”.'}</div>`
      : html`<div class="dlist">${s.results.map((r) => html`<div class="drow search-res" data-act="openresult" data-path=${r.projectPath}>
          <div class="drow-main">
            <div class="drow-title">${r.snippet}</div>
            <div class="drow-meta">
              ${vendorChip(r.vendor)}
              <span class="proj-name">${r.project}</span><span class="sep">·</span><span>${ago(r.date)}</span>
              <span class="sep">·</span><span class="num">${r.count} match${r.count === 1 ? '' : 'es'}</span>
            </div>
          </div>
          <div class="res-actions">
            ${r.vendor === 'codex'
              ? html`<span class="res-note" title="Codex session — resume from your Codex CLI; in-app resume is Claude-only for now">found in Codex</span>`
              : html`${cockpitBtn(r.sessionId, r.projectPath, r.project)}
                <button class="btn" data-act="resume" data-id=${r.sessionId} data-path=${r.projectPath} title="Resume in a separate terminal window">${iTerminal()} Resume in terminal</button>`}
          </div>
        </div>`)}</div>`}
  </section>`;
}

function cockpitAddPanel(d: OverviewPayload, state: State): Tpl | string {
  const cp = state.ui.cockpit;
  if (!cp.addOpen) return '';
  const q = cp.addQuery.trim();
  const rows = q
    // Codex results are excluded here: adding a resume tile spawns `claude --resume`,
    // which can't resume a Codex session (cockpit Codex-resume isn't wired yet, #11 phase 2).
    ? cp.addResults.filter((r) => r.vendor !== 'codex').map((r) => ({ id: r.sessionId, path: r.projectPath, title: r.project, sub: r.snippet }))
    : d.sessions.filter((s) => s.id).map((s) => ({ id: s.id!, path: s.path, title: s.project, sub: s.currentAction || s.status }));
  return html`<div class="cp-add-backdrop">
    <div class="cp-add">
      <div class="cp-add-head"><span>Add a session</span><button class="btn icon" data-act="cockpit-add-close" title="Close">&#10005;</button></div>
      <input id="cockpit-add-search" class="search" placeholder="Search conversations to add…" .value=${cp.addQuery}>
      <div class="cp-add-list">
        ${rows.length ? rows.map((r) => html`<div class="cp-add-row">
          <div class="cp-add-main"><div class="cp-add-title">${r.title}</div><div class="cp-add-sub">${r.sub}</div></div>
          <button class="btn" data-act="cockpit-add-resume" data-id=${r.id} data-path=${r.path} data-title=${r.title}>+ Add</button>
        </div>`) : html`<div class="empty">${q ? 'No matches.' : 'No recent conversations.'}</div>`}
      </div>
      <div class="cp-add-new">
        <span class="cp-add-or">or start new in</span>
        <select id="cockpit-new-project" class="cp-select">
          ${d.projects.map((p) => html`<option value=${p.path}>${p.name}</option>`)}
        </select>
        <button class="btn primary" data-act="cockpit-add-new">${iPlay()} New session</button>
      </div>
      ${d.features.agents.length > 1 ? html`<div class="cp-agents"><span class="cp-add-or">agent</span>
        ${d.features.agents.map((a) => html`<label class=${'cp-agent' + (a.available ? '' : ' off')} title=${a.available ? a.label : a.label + ' CLI not installed'}>
          <input type="radio" name="cp-agent" value=${a.id} ?disabled=${!a.available} ?checked=${a.id === 'claude'}> ${a.label}${a.available ? '' : ' (install)'}</label>`)}
        ${(d.features.providers ?? []).map((p) => html`<label class=${'cp-agent cp-provider' + (p.available ? '' : ' off')}
          title=${p.available ? 'Run Claude Code against ' + p.label + (p.model ? ' (' + p.model + ')' : '') + ' — your prompts go to this provider' : p.label + ' — set ' + p.keyHint + ' (or add a key in config) to enable'}>
          <input type="radio" name="cp-agent" value=${p.id} ?disabled=${!p.available}> ${p.label}${p.available ? '' : ' (add key)'}</label>`)}
      </div>` : ''}
      <div class="cp-add-doc">
        <span class="cp-add-or">or open a doc</span>
        <select id="cockpit-doc-project" class="cp-select">${d.projects.map((p) => html`<option value=${p.path}>${p.name}</option>`)}</select>
        <input id="cockpit-doc-path" class="search" placeholder="path, e.g. notes/draft.md">
        <button class="btn" data-act="cockpit-add-doc">${iBranch()} Open doc</button>
      </div>
      <label class="cp-wt"><input type="checkbox" id="cockpit-new-worktree"> ${iBranch()} Isolated worktree
        <span class="cp-wt-hint">— runs on its own branch so it won't collide with other sessions</span></label>
      <input id="cockpit-new-branch" class="search" placeholder="branch name (default: cockpit/session-N)" style="display:none">
    </div>
  </div>`;
}

// ── notes library overlay (Phase 2) ─────────────────────────
// Browse notepads across a conversation, a project, or everywhere; click one to
// dock it into the active conversation (or open standalone if no chat is up).
function notesOverlay(d: OverviewPayload, state: State): Tpl | string {
  const cp = state.ui.cockpit;
  if (!cp.notesOpen) return '';
  const q = cp.notesQuery.trim();
  const rows = cp.notesResults; // server already applied scope + full-text query
  const nameOf = (p: string) => d.projects.find((pr) => pr.path === p)?.name || (p ? p.split(/[/\\]/).pop() : '') || '';
  const scopeBtn = (id: 'conversation' | 'project' | 'all', label: string) =>
    html`<button class=${'notes-scope' + (cp.notesScope === id ? ' on' : '')} data-act="notes-scope" data-scope=${id}>${label}</button>`;
  return html`<div class="cp-add-backdrop notes-backdrop">
    <div class="cp-add notes-lib">
      <div class="cp-add-head"><span>&#128221; Notes</span><button class="btn icon" data-act="notes-close" title="Close (Esc)">&#10005;</button></div>
      <div class="notes-scopes">
        ${scopeBtn('conversation', 'This conversation')}
        ${scopeBtn('project', 'This project')}
        ${scopeBtn('all', 'All')}
      </div>
      <input id="notes-search" class="search" placeholder="Search notes — title &amp; body…" .value=${cp.notesQuery}>
      <div class="cp-add-list notes-list">
        ${rows.length ? rows.map((n) => html`<div class="notes-row" data-act="notes-open" data-path=${n.path} title=${n.path}>
          <div class="notes-main">
            <div class="notes-title">${n.title || 'untitled'}</div>
            <div class="notes-sub">${n.preview || '—'}</div>
          </div>
          <div class="notes-meta">
            ${n.project ? html`<span class="notes-proj">${nameOf(n.project)}</span>` : ''}
            <span class="notes-ago">${ago(new Date(n.updated).toISOString())}</span>
          </div>
        </div>`) : html`<div class="empty">${q ? 'No matching notes.' : 'No notes in this scope yet.'}</div>`}
      </div>
    </div>
  </div>`;
}

/** Floating controls OVER the cockpit/stats surface — they don't reserve height
 *  (no top bar), so the cockpit runs full-height now that the topbar + the old
 *  cockpit toolbar are gone. Cockpit: "N waiting" (right). Stats: the range
 *  selector (right). Project focus is driven by the sidebar conversation list —
 *  there's no separate chip row. */
function cockpitFloat(state: State): Tpl {
  const cp = state.ui.cockpit;
  if (cp.tab === 'stats') {
    return html`<div class="cp-float cp-float-r">
      <div class="cp-range">${([[1, '24h'], [3, '3d'], [7, '7d'], [30, '30d']] as Array<[number, string]>).map(([dys, lbl]) =>
        html`<button class=${'btn icon' + (cp.statsDays === dys ? ' on' : '')} data-act="stats-days" data-days=${String(dys)}>${lbl}</button>`)}
      </div></div>`;
  }
  const waiting = (cp.attnTiles?.length ?? 0) > 0;
  return html`${waiting ? html`<div class="cp-float cp-float-r"><button class="cp-wait" data-act="cockpit-waiting"
      title="A conversation finished its turn / wants input — click to jump to it">● ${cp.attnTiles.length} waiting</button></div>` : ''}`;
}

// ── restore workspace (banner + spatial chooser) ─────────────
// Stale-reopen flow: a slim banner offers Restore all / Choose… / Dismiss; the
// chooser is a drag-and-drop map of the last session — a Cockpit zone with tile
// cards, an Own-windows zone for popped-out conversations, and a Don't-restore
// zone. Drag between zones (or uncheck) to pick where each conversation reopens.

function rstVendorChip(vendor?: string): Tpl | string {
  if (!vendor || vendor === 'claude') return '';
  const label = vendor === 'antigravity' ? '✦ agy' : vendor === 'codex' ? '⬡ codex' : vendor;
  return html`<span class=${'vendor-chip ' + vendor}>${label}</span>`;
}

function rstMeter(it: RestoreItem): Tpl {
  if (it.ctxPct == null) return html`<div class="rst-ctx dim">${it.tile.kind === 'doc' ? 'notepad / document' : 'context: —'}</div>`;
  const level = it.ctxPct >= 85 ? 'crit' : it.ctxPct >= 65 ? 'warn' : '';
  return html`<div class="rst-ctx">
    <div class=${'rst-meter ' + level}><i style=${'width:' + it.ctxPct + '%'}></i></div>
    <span class="num">${it.ctxPct}%</span><span>of ctx</span>
  </div>`;
}

function rstCard(it: RestoreItem): Tpl {
  const t = it.tile;
  const skip = it.dest === 'skip';
  const proj = t.projectPath ? (t.projectPath.split(/[/\\]/).pop() || t.projectPath) : '';
  const canPeek = !!it.lastPrompts?.length;
  return html`<div class=${'rst-card' + (skip ? ' skip' : '')} draggable="true" data-rid=${t.id}>
    <div class="rst-row">
      <input type="checkbox" data-act="restore-ck" data-id=${t.id} ?checked=${!skip} title="Keep / skip">
      <span class="rst-title" title=${t.title}>${t.title}</span>
    </div>
    <div class="rst-row rst-meta">
      <span class="rst-proj">${proj}</span>${rstVendorChip(t.vendor)}
      ${it.origin === 'win' ? html`<span class="rst-chip">⧉ window</span>` : ''}
      ${t.kind === 'doc' ? html`<span class="rst-chip">✎ doc</span>` : ''}
    </div>
    ${it.summary ? html`<div class="rst-sum" title=${it.summary}>${it.summary}</div>` : ''}
    ${it.peek && canPeek ? html`<div class="rst-peek"><div class="rst-pkh">last prompts</div>
      ${it.lastPrompts!.map((p) => html`<div class="rst-pkp" title=${p}>› ${p}</div>`)}</div>` : ''}
    <div class="rst-row">
      ${rstMeter(it)}
      ${canPeek ? html`<button class=${'rst-pkbtn' + (it.peek ? ' on' : '')} data-act="restore-peek" data-id=${t.id}
        title="Show the last prompts sent to this conversation">${it.peek ? '▴' : '▾'}</button>` : ''}
    </div>
  </div>`;
}

function rstZone(ro: RestoreOffer, zone: 'grid' | 'win' | 'skip'): Tpl {
  const items = ro.items.filter((i) => i.dest === zone);
  const label = zone === 'grid' ? '▦ Cockpit' : zone === 'win' ? '⧉ Own windows' : '✕ Don’t restore';
  const hint = zone === 'skip' ? html`<div class="rst-hint">drop here to leave a conversation behind — it stays in the sidebar list</div>` : '';
  return html`<div class=${'rst-zone rst-zone-' + zone} data-rzone=${zone}>
    <h3>${label} <span class="rst-cnt">(${items.length})</span></h3>
    <div class="rst-cards">${items.map(rstCard)}${hint}</div>
  </div>`;
}

function restoreChooser(ro: RestoreOffer): Tpl {
  const g = ro.items.filter((i) => i.dest === 'grid').length;
  const w = ro.items.filter((i) => i.dest === 'win').length;
  const s = ro.items.filter((i) => i.dest === 'skip').length;
  return html`<div class="rst-back">
    <div class="rst-modal">
      <div class="rst-head">
        <h2>Restore your workspace</h2>
        <span class="rst-sub">drag a conversation between zones · uncheck to skip it</span>
        <span class="sp"></span>
        <button class="btn icon" data-act="restore-chooser-close" title="Back to the banner">✕</button>
      </div>
      <div class="rst-body"><div class="rst-zones">
        ${rstZone(ro, 'grid')}${rstZone(ro, 'win')}${rstZone(ro, 'skip')}
      </div></div>
      <div class="rst-foot">
        <span class="rst-hint">Would restore ${g} into the cockpit${w ? ' + ' + w + ' as own window' + (w === 1 ? '' : 's') : ''}${s ? ', skip ' + s : ''}</span>
        <span class="sp"></span>
        <button class="btn ghost" data-act="restore-dismiss">Start fresh</button>
        <button class="btn primary" data-act="restore-apply">Restore</button>
      </div>
    </div>
  </div>`;
}

// ── root ─────────────────────────────────────────────────────
export function appView(state: State): Tpl {
  const d = state.data;
  if (!d) return html`<div class="loading">Loading dashboard…</div>`;
  const showSearch = !!state.search.query.trim();
  const home = !showSearch && !state.ui.selectedProject;     // the cockpit / stats surface (cockpit + stats are imperative overlays)
  const showDetail = !showSearch && !home;
  const matchPaths = showSearch ? new Set(state.search.results.map((r) => normPath(r.projectPath))) : null;
  const ro = state.ui.restoreOffer;
  return html`
    ${ro ? html`<div class="restore-banner">
      <span>↩ Pick up where you left off — restore ${ro.items.length} conversation${ro.items.length === 1 ? '' : 's'} from your last session?</span>
      <span class="sp"></span>
      <button class="btn primary" data-act="restore-accept">Restore all</button>
      <button class="btn" data-act="restore-choose">Choose…</button>
      <button class="btn" data-act="restore-dismiss">Dismiss</button>
    </div>` : ''}
    ${ro?.chooserOpen ? restoreChooser(ro) : ''}
    ${home ? cockpitFloat(state) : ''}
    <div class="body">
      ${sidebar(d, state, state.search.query, matchPaths)}
      <div class="side-divider" data-act="sidebar-toggle" title=${state.ui.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
        <span class="side-handle">${state.ui.sidebarCollapsed ? '›' : '‹'}</span>
      </div>
      <main class="main">
        ${showSearch ? searchView(state)
          : showDetail ? projectDetail(d, state)
          : ''}
      </main>
    </div>
    ${cockpitAddPanel(d, state)}
    ${notesOverlay(d, state)}
  `;
}
