/** All dashboard views, rendered declaratively with uhtml from store state. */
import { html } from 'uhtml';
import type { OverviewPayload, SessionInfo, ProjectInfo, UsageWindow, HeatCell, TouchedFile } from './types.js';
import type { State, SortKey } from './store.js';
import { tok, ago, dur, turnsPerReq, clamp } from './util.js';
import { THEMES, currentTheme } from './theme.js';

/** Anything `html\`\`` can return (a rendered node or a Tpl placeholder). */
type Tpl = ReturnType<typeof html>;

// ── icons (inline SVG, currentColor) ─────────────────────────
const svgWrap = (path: Tpl) => html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const iPlay = () => svgWrap(html`<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"></polygon>`);
const iTerminal = () => svgWrap(html`<polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line>`);
const iBranch = () => svgWrap(html`<circle cx="6" cy="6" r="2.4"></circle><circle cx="6" cy="18" r="2.4"></circle><circle cx="18" cy="7" r="2.4"></circle><path d="M6 8.4v7.2M8.4 6.4H14a3 3 0 0 1 3 3v0"></path>`);
const iGrid = () => svgWrap(html`<rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect>`);

/** "Open here" button — opens a conversation as a live terminal tile in the cockpit. */
function cockpitBtn(sessionId: string, projectPath: string, title: string): Tpl {
  return html`<button class="btn" data-act="openincockpit" data-id=${sessionId} data-path=${projectPath} data-title=${title}>${iGrid()} Open here</button>`;
}

// ── small viz helpers ────────────────────────────────────────
function heatLevel(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  const r = v / max;
  return r > 0.66 ? 4 : r > 0.33 ? 3 : r > 0.1 ? 2 : 1;
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

function ctxGauge(ctx: number): Tpl | string {
  if (!ctx || ctx <= 0) return '';
  const CAP = 200000;
  const pct = clamp(Math.round((ctx / CAP) * 100), 0, 100);
  const cls = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : '';
  return html`<div class="ctx-gauge" title=${'context ' + tok(ctx) + ' / ~200k'}><div class=${cls} style=${'width:' + pct + '%'}></div></div>`;
}

function themeSwitch(): Tpl {
  const cur = currentTheme();
  return html`<div class="theme-switch" title="Theme">
    ${THEMES.map((t) => html`<button class=${'sw sw-' + t.id + (cur === t.id ? ' on' : '')}
      data-act="theme" data-theme=${t.id} title=${t.label} aria-label=${t.label}></button>`)}
  </div>`;
}

// ── usage header (sticky) ────────────────────────────────────
function topbar(d: OverviewPayload, connError: boolean, cockpitCount: number): Tpl {
  const live = d.sessions.filter((s) => s.status === 'active').length;
  const idle = d.sessions.length - live;
  return html`<header class="topbar">
    <div class="brand">
      <span class="logo" aria-hidden="true"></span>
      <span class="wordmark">CLD CTRL</span>
      ${d.tier ? html`<span class="tier">${d.tier}</span>` : ''}
    </div>
    <div class="usage-mini">
      <span class="um-label">5h</span>${usageBar(d.usage.fiveHour)}
      <span class="um-label">7d</span>${usageBar(d.usage.sevenDay)}
    </div>
    ${d.usage.overage ? html`<span class="overage" title=${'Paid overage · resets ' + d.usage.overage.resetIn}>
      ⚠ EXTRA <span class="num">${d.usage.overage.percent}%</span></span>` : ''}
    <div class="topbar-right">
      <span class="live-count"><span class="dot active"></span>${live} live${idle ? html` · ${idle} idle` : ''}</span>
      <span class="updated">${connError ? 'reconnecting…' : 'updated ' + new Date(d.generatedAt).toLocaleTimeString()}</span>
      ${themeSwitch()}
      ${d.features.agentTerminal
        ? html`<button class="btn" data-act="dockToggle" title="Agent control plane">${iTerminal()} Agent</button>`
        : ''}
    </div>
  </header>`;
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
  return html`<div class=${'proj-row' + (selected ? ' selected' : '') + mark} data-act="selectproject" data-path=${p.path}>
    <span class=${dotCls}></span>
    <span class="proj-name">${p.name}</span>
    ${gitBadge(p)}
  </div>`;
}

function sidebar(d: OverviewPayload, ui: State['ui'], query: string, matchPaths: Set<string> | null): Tpl {
  const searching = !!query.trim();
  return html`<aside class="sidebar">
    <div class="search-box">
      <input id="search-input" class="search" placeholder="Search conversations…" .value=${query}>
      ${searching ? html`<button class="search-clear" data-act="searchclear" title="Clear">✕</button>` : ''}
    </div>
    <nav class="side-nav">
      <button class=${'nav-item' + (!ui.selectedProject && !searching ? ' selected' : '')} data-act="home">Conversations</button>
    </nav>
    <div class="side-head">Projects ${matchPaths ? html`<span class="hint">— ${matchPaths.size} in results</span>` : html`<span class="hint">— click to inspect</span>`}</div>
    <div class="proj-list">
      ${d.projects.length ? d.projects.map((p) => projectRow(p, ui, matchPaths)) : html`<div class="empty">No projects. Run a scan in the TUI.</div>`}
    </div>
  </aside>`;
}

// ── conversations table ──────────────────────────────────────
const COLS: Array<{ key: SortKey; label: string; cls?: string }> = [
  { key: 'tokens', label: 'Tokens', cls: 'r' },
  { key: 'share', label: 'Share', cls: 'r' },
  { key: 'msgs', label: 'Msgs', cls: 'r' },
  { key: 'tr', label: 'T/R', cls: 'r' },
  { key: 'ctx', label: 'Ctx', cls: 'r' },
  { key: 'dur', label: 'Dur', cls: 'r' },
  { key: 'ago', label: 'Active', cls: 'r' },
];

function sortValue(s: SessionInfo, key: SortKey): number {
  switch (key) {
    case 'tokens': return s.tokens;
    case 'share': return s.tokens;
    case 'msgs': return s.messages;
    case 'tr': return s.assistantTurns / Math.max(1, s.messages);
    case 'ctx': return s.contextSize;
    case 'dur': return s.durationMs;
    case 'ago': return -new Date(s.lastActivity).getTime(); // recent first when desc
  }
}

function fileTree(files: TouchedFile[]): Tpl {
  if (!files.length) return html`<div class="empty">No files touched yet.</div>`;
  const dirs = new Map<string, Array<TouchedFile & { name: string }>>();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const dir = i === -1 ? '.' : f.path.slice(0, i);
    const name = i === -1 ? f.path : f.path.slice(i + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push({ ...f, name });
  }
  const sorted = [...dirs.entries()].sort(
    (a, b) => Math.max(...b[1].map((f) => f.lastTs)) - Math.max(...a[1].map((f) => f.lastTs)),
  );
  const now = Date.now();
  return html`${sorted.map(([dir, fl]) => html`
    <div class="ft-dir">${dir}/</div>
    ${fl.sort((a, b) => b.lastTs - a.lastTs).map((f) => {
      const hot = now - f.lastTs < 120000;
      return html`<div class=${'ft-file' + (hot ? ' hot' : '')} title=${f.path}>
        ${f.name}${f.writes ? html` <span class="ft-w num">✎${f.writes}</span>` : ''}${f.reads ? html` <span class="ft-r num">${f.reads}×</span>` : ''}
      </div>`;
    })}
  `)}`;
}

function transcriptView(state: State): Tpl {
  const t = state.transcript;
  if (!t || t.id !== state.ui.expandedSessionId) return html`<div class="empty">Loading…</div>`;
  if (!t.entries.length) return html`<div class="empty">No transcript yet.</div>`;
  return html`${t.entries.map((e) => html`<div class=${'t-' + e.role}>${
    e.role === 'user' ? '❯ ' : e.role === 'tool' ? '⚙ ' : ''}${e.text}</div>`)}`;
}

function sessionDetail(s: SessionInfo, state: State): Tpl {
  return html`<div class="detail">
    <div class="detail-cols">
      <div class="transcript" id="transcript">${transcriptView(state)}</div>
      <div class="ft">
        <div class="ft-head">Files touched</div>
        <div class="filetree">${fileTree(s.files)}</div>
      </div>
    </div>
    ${s.id ? html`<div class="detail-actions">
      <button class="btn primary" data-act="resume" data-id=${s.id} data-path=${s.path}>${iPlay()} Resume in terminal</button>
      ${cockpitBtn(s.id, s.path, s.project)}
    </div>` : ''}
  </div>`;
}

function sessionRow(s: SessionInfo, totalTokens: number, state: State): Tpl {
  const expanded = !!s.id && s.id === state.ui.expandedSessionId;
  const sharePct = totalTokens > 0 ? Math.round((s.tokens / totalTokens) * 100) : 0;
  return html`<div class=${'srow' + (expanded ? ' expanded' : '')}>
    <div class="srow-head" data-act="toggle" data-id=${s.id ?? ''}>
      <div class="srow-id">
        <span class=${'dot ' + s.status}></span>
        <div class="srow-main">
          <div class="srow-title">
            <span class="proj-name">${s.project}</span>
            ${s.currentAction && s.status === 'active' ? html`<span class="action">› ${s.currentAction}</span>` : ''}
          </div>
          <div class="share-bar"><div style=${'width:' + sharePct + '%'}></div></div>
        </div>
      </div>
      <span class="c num r">${tok(s.tokens)}</span>
      <span class="c num r">${sharePct}%</span>
      <span class="c num r">${s.messages}</span>
      <span class="c num r">${turnsPerReq(s.assistantTurns, s.messages)}</span>
      <span class="c num r ctxcell">${tok(s.contextSize)}${ctxGauge(s.contextSize)}</span>
      <span class="c num r">${dur(s.durationMs)}</span>
      <span class="c num r ago">${ago(s.lastActivity)}</span>
    </div>
    ${expanded ? sessionDetail(s, state) : ''}
  </div>`;
}

function conversations(d: OverviewPayload, state: State): Tpl {
  const live = d.sessions.filter((s) => s.status === 'active').length;
  const idle = d.sessions.length - live;
  const totalTokens = d.sessions.reduce((a, s) => a + s.tokens, 0);
  const { sortKey, sortDir } = state.ui;
  const sorted = [...d.sessions].sort((a, b) => (sortValue(b, sortKey) - sortValue(a, sortKey)) * sortDir);

  return html`<section class="card conv">
    <div class="card-head">
      <h2>Conversations</h2>
      <span class="card-meta">${live} live${idle ? ' · ' + idle + ' idle' : ''}</span>
    </div>
    ${d.sessions.length === 0
      ? html`<div class="empty">No sessions in the last 5h window. Launch a project from the sidebar.</div>`
      : html`<div class="conv-table">
          <div class="thead">
            <span class="col-proj">Session</span>
            ${COLS.map((c) => html`<span class=${'th ' + (c.cls ?? '') + (sortKey === c.key ? ' active' : '')}
              data-act="sort" data-key=${c.key}>${c.label}${sortKey === c.key ? (sortDir === 1 ? ' ↓' : ' ↑') : ''}</span>`)}
          </div>
          ${sorted.map((s) => sessionRow(s, totalTokens, state))}
        </div>`}
  </section>`;
}

function activityCard(d: OverviewPayload): Tpl {
  const hasCommits = d.usage.dailyCommits.some((c) => c.value > 0);
  return html`<section class="card activity">
    <div class="card-head"><h2>Activity</h2><span class="card-meta">last 28 days</span></div>
    <div class="heat-row">
      <div class="heat-wrap">
        <div class="sub">Tokens</div>
        ${heatmap(d.usage.daily, 'tok')}
      </div>
      ${hasCommits ? html`<div class="heat-wrap">
        <div class="sub">Commits</div>
        ${heatmap(d.usage.dailyCommits, 'com')}
      </div>` : ''}
    </div>
  </section>`;
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
          <button class="btn" data-act="resume" data-id=${s.id} data-path=${projectPath}>${iPlay()} Resume</button>
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
      <button class="btn primary" data-act="newsession" data-path=${projPath}>${iPlay()} New session</button>
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
              <span class="proj-name">${r.project}</span><span class="sep">·</span><span>${ago(r.date)}</span>
              <span class="sep">·</span><span class="num">${r.count} match${r.count === 1 ? '' : 'es'}</span>
            </div>
          </div>
          <div class="res-actions">
            ${cockpitBtn(r.sessionId, r.projectPath, r.project)}
            <button class="btn" data-act="resume" data-id=${r.sessionId} data-path=${r.projectPath}>${iPlay()} Resume</button>
          </div>
        </div>`)}</div>`}
  </section>`;
}

function cockpitAddPanel(d: OverviewPayload, state: State): Tpl | string {
  const cp = state.ui.cockpit;
  if (!cp.addOpen) return '';
  const q = cp.addQuery.trim();
  const rows = q
    ? cp.addResults.map((r) => ({ id: r.sessionId, path: r.projectPath, title: r.project, sub: r.snippet }))
    : d.sessions.filter((s) => s.id).map((s) => ({ id: s.id!, path: s.path, title: s.project, sub: s.currentAction || s.status }));
  return html`<div class="cp-add-backdrop">
    <div class="cp-add">
      <div class="cp-add-head"><span>Add to cockpit</span><button class="btn icon" data-act="cockpit-add-close" title="Close">&#10005;</button></div>
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

// ── conversations-pane tabs (List / Cockpit) ─────────────────
function convTabs(d: OverviewPayload, state: State): Tpl {
  const cp = state.ui.cockpit;
  const live = d.sessions.filter((s) => s.status === 'active').length;
  return html`<div class="conv-tabs">
    <button class=${'conv-tab' + (!cp.open ? ' active' : '')} data-act="view-list">List${live ? html` <span class="num">${live} live</span>` : ''}</button>
    <button class=${'conv-tab' + (cp.open ? ' active' : '')} data-act="view-cockpit">Cockpit${cp.tiles.length ? html` <span class="num">${cp.tiles.length}</span>` : ''}</button>
    ${cp.open ? html`<span class="sp"></span>
      <button class="btn primary" data-act="cockpit-add-toggle" title="Add a session">+ Add</button>
      <div class="cp-layouts">
        <button class=${'btn icon' + (cp.layout === 'cols1' ? ' on' : '')} data-act="cockpit-layout" data-layout="cols1" title="Single column">&#9647;</button>
        <button class=${'btn icon' + (cp.layout === 'cols2' ? ' on' : '')} data-act="cockpit-layout" data-layout="cols2" title="Two columns">&#9707;</button>
        <button class=${'btn icon' + (cp.layout === 'grid' ? ' on' : '')} data-act="cockpit-layout" data-layout="grid" title="Grid">&#9638;</button>
      </div>` : ''}
  </div>`;
}

// ── root ─────────────────────────────────────────────────────
export function appView(state: State): Tpl {
  const d = state.data;
  if (!d) return html`<div class="loading">Loading dashboard…</div>`;
  const showSearch = !!state.search.query.trim();
  const home = !showSearch && !state.ui.selectedProject;     // the Conversations pane (List or Cockpit)
  const showDetail = !showSearch && !home;
  const showCockpit = home && state.ui.cockpit.open;
  const matchPaths = showSearch ? new Set(state.search.results.map((r) => normPath(r.projectPath))) : null;
  return html`
    ${topbar(d, state.connError, state.ui.cockpit.tiles.length)}
    ${home ? convTabs(d, state) : ''}
    <div class="body">
      ${sidebar(d, state.ui, state.search.query, matchPaths)}
      <div class="side-divider" data-act="sidebar-toggle" title=${state.ui.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
        <span class="side-handle">${state.ui.sidebarCollapsed ? '›' : '‹'}</span>
      </div>
      <main class="main">
        ${showSearch ? searchView(state)
          : showDetail ? projectDetail(d, state)
          : showCockpit ? ''
          : html`${activityCard(d)}${conversations(d, state)}`}
      </main>
    </div>
    ${cockpitAddPanel(d, state)}
  `;
}
