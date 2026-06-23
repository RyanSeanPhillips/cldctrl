/**
 * Cockpit Stats panel. Fetches /api/stats and renders hand-rolled SVG charts
 * (token usage by 5h block + 7d overlay, per-turn billed, context-per-conversation
 * with 1M reference lines, tool-result context, MCP/agent tables). Rendered
 * imperatively into #stats (outside the uhtml tree, like the cockpit grid).
 */
import { getState } from './store.js';
import type { StatsPayload } from './types.js';
import { fetchStats, fetchBucketImages } from './api.js';

const ACCENT = '#e87632', TEAL = '#2dd4bf', AMBER = '#f59e0b', BLUE = '#388cff', RED = '#ff6b6b', VIOLET = '#a29bfe';
const RAINBOW = [ACCENT, TEAL, BLUE, VIOLET, AMBER, '#fd79a8'];
const DAY = 86400e3, HOUR = 3600e3;
const W = 880, PLOT_L = 8, PLOT_R = 64, PADT = 6, PADB = 4;

function fmt(n: number): string { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n)); }
function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
function niceCeil(v: number): number { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / p) * p; }

function imgIcon(x: number, y: number, n: number, color: string, attrs: string): string {
  const s = Math.min(9 + n, 13), X = (x - s / 2).toFixed(1), Y = (y - s / 2).toFixed(1);
  return `<g ${attrs} transform="translate(${X},${Y})"><title>${n} image${n === 1 ? '' : 's'}</title>`
    + `<rect width="${s}" height="${s}" rx="1.5" fill="#0d1117" stroke="${color}" stroke-width="1"/>`
    + `<circle cx="${(s * 0.3).toFixed(1)}" cy="${(s * 0.32).toFixed(1)}" r="${(s * 0.13).toFixed(1)}" fill="${color}"/>`
    + `<path d="M1.5,${(s - 1.5).toFixed(1)} L${(s * 0.42).toFixed(1)},${(s * 0.52).toFixed(1)} L${(s * 0.62).toFixed(1)},${(s * 0.7).toFixed(1)} L${(s - 1.5).toFixed(1)},${(s * 0.36).toFixed(1)} L${(s - 1.5).toFixed(1)},${(s - 1.5).toFixed(1)} L1.5,${(s - 1.5).toFixed(1)} Z" fill="${color}" fill-opacity="0.75"/></g>`;
}

function buildBody(p: StatsPayload): string {
  if (!p.turns.length) return `<div class="stats-empty">No usage in the last ${p.days} day${p.days === 1 ? '' : 's'} yet.</div>`;
  const t0 = p.generatedAt - p.days * DAY, t1 = p.generatedAt;
  const xT = (ts: number) => PLOT_L + (ts - t0) / (t1 - t0) * (W - PLOT_L - PLOT_R);
  const sess = p.sessions;
  const labelFor = (id: string) => id === 'other' ? 'other' : (sess.find((s) => s.id === id)?.label ?? id.slice(0, 6));
  const totalOf = (id: string) => id === 'other' ? sess.filter((s) => !topSet.has(s.id)).reduce((a, s) => a + s.total, 0) : (sess.find((s) => s.id === id)?.total ?? 0);
  const labelData = (id: string) => `${esc(labelFor(id))} — ${fmt(totalOf(id))} tokens`;
  const order = [...sess].sort((a, b) => b.total - a.total);
  const top = order.slice(0, 6).map((s) => s.id);
  const topSet = new Set(top);
  const seriesKeys = [...top, 'other'];
  const colorOf = (id: string) => id === 'other' ? '#56607a' : RAINBOW[top.indexOf(id) % RAINBOW.length];
  const sessIdOf = (i: number) => sess[i]?.id ?? 'other';
  const keyOfTurn = (s: number) => { const id = sessIdOf(s); return topSet.has(id) ? id : 'other'; };

  // shared x-axis
  const tickStep = p.days <= 2 ? 6 * HOUR : p.days <= 7 ? DAY : 2 * DAY;
  const ticks: number[] = [];
  for (let tk = Math.ceil(t0 / tickStep) * tickStep; tk <= t1; tk += tickStep) ticks.push(tk);
  const tickLabel = (ts: number) => p.days <= 2 ? new Date(ts).toLocaleTimeString([], { hour: 'numeric' }) : (new Date(ts).getMonth() + 1) + '/' + new Date(ts).getDate();
  const gridLines = (h: number) => ticks.map((tk) => `<line x1="${xT(tk).toFixed(1)}" y1="2" x2="${xT(tk).toFixed(1)}" y2="${h - 2}" stroke="#161b26" stroke-width="1"/>`).join('');
  const axisSvg = `<svg viewBox="0 0 ${W} 22" width="100%" style="display:block">${ticks.map((tk) => `<line x1="${xT(tk).toFixed(1)}" y1="0" x2="${xT(tk).toFixed(1)}" y2="4" stroke="#3a4453"/><text x="${xT(tk).toFixed(1)}" y="16" text-anchor="middle" fill="#808090" font-size="10">${tickLabel(tk)}</text>`).join('')}<text x="${W - PLOT_R + 4}" y="16" fill="#808090" font-size="10">now</text></svg>`;

  // ── CHART 1: token usage by rolling 5h block (stacked) + 7d cumulative overlay (right axis) ──
  const H1 = 140, FIVEH = 5 * HOUR;
  const blocks: Array<{ start: number; snaps: Array<{ ts: number; snap: Record<string, number> }>; total: number }> = [];
  for (const tn of p.turns) { if (!blocks.length || tn.t >= blocks[blocks.length - 1].start + FIVEH) blocks.push({ start: tn.t, snaps: [], total: 0 }); const b = blocks[blocks.length - 1]; const last = b.snaps.length ? { ...b.snaps[b.snaps.length - 1].snap } : Object.fromEntries(seriesKeys.map((k) => [k, 0])); last[keyOfTurn(tn.s)] += tn.k; b.snaps.push({ ts: tn.t, snap: last }); }
  let maxBlock = 0;
  for (const b of blocks) { const last = b.snaps[b.snaps.length - 1].snap; b.total = seriesKeys.reduce((s, k) => s + last[k], 0); if (b.total > maxBlock) maxBlock = b.total; }
  const LIMIT = niceCeil(maxBlock * 1.05), yMax1 = LIMIT * 1.08;
  const yTok = (v: number) => H1 - PADB - (v / yMax1) * (H1 - PADT - PADB);
  let bands1 = '';
  for (const b of blocks) {
    if (b.snaps.length < 2) { const x = xT(b.snaps[0].ts); bands1 += `<rect x="${(x - 1).toFixed(1)}" y="${yTok(b.total).toFixed(1)}" width="2" height="${(yTok(0) - yTok(b.total)).toFixed(1)}" fill="${ACCENT}" fill-opacity="0.5"/>`; continue; }
    for (let ki = seriesKeys.length - 1; ki >= 0; ki--) {
      const k = seriesKeys[ki]; const upper: string[] = [], lower: string[] = [];
      for (const pt of b.snaps) { let under = 0; for (let j = 0; j < ki; j++) under += pt.snap[seriesKeys[j]]; lower.push(xT(pt.ts).toFixed(1) + ',' + yTok(under).toFixed(1)); upper.push(xT(pt.ts).toFixed(1) + ',' + yTok(under + pt.snap[k]).toFixed(1)); }
      bands1 += `<path class="band" data-conv="${esc(k)}" data-label="${labelData(k)}" d="M${upper.join(' L')} L${lower.reverse().join(' L')} Z" fill="${colorOf(k)}" fill-opacity="0.8"/>`;
    }
  }
  const resetMarks = blocks.map((b) => `<line x1="${xT(b.start).toFixed(1)}" y1="${PADT}" x2="${xT(b.start).toFixed(1)}" y2="${H1 - PADB}" stroke="${TEAL}" stroke-dasharray="2 3" stroke-width="1" stroke-opacity="0.5"/>`).join('');
  const limitY = yTok(LIMIT).toFixed(1);
  const limitLine = `<line x1="${PLOT_L}" y1="${limitY}" x2="${W - PLOT_R}" y2="${limitY}" stroke="${RED}" stroke-dasharray="6 4" stroke-width="1.3"/><text x="${W - PLOT_R + 4}" y="${(+limitY - 3)}" fill="${RED}" font-size="9">5h≈${fmt(LIMIT)}</text>`;
  let run = 0; const wkPts = p.turns.map((tn) => { run += tn.k; return [xT(tn.t), run] as [number, number]; });
  const WEEKLY = p.limits.sevenD ?? niceCeil(run * (p.days >= 7 ? 1.05 : 7 / p.days));
  const yWk2 = (v: number) => H1 - PADB - (v / (WEEKLY * 1.05)) * (H1 - PADT - PADB);
  const wkLimY = yWk2(WEEKLY).toFixed(1);
  const overlay7d = `<polyline fill="none" stroke="${TEAL}" stroke-width="1.8" stroke-opacity="0.95" points="${wkPts.map((q) => q[0].toFixed(1) + ',' + yWk2(q[1]).toFixed(1)).join(' ')}"/>`
    + `<line x1="${PLOT_L}" y1="${wkLimY}" x2="${W - PLOT_R}" y2="${wkLimY}" stroke="${TEAL}" stroke-dasharray="5 4" stroke-width="1" stroke-opacity="0.65"/>`
    + `<text x="${W - PLOT_R + 4}" y="${(+wkLimY + 9)}" fill="${TEAL}" font-size="9">7d≈${fmt(WEEKLY)}</text><text x="${W - PLOT_R + 4}" y="${(yWk2(run) - 2).toFixed(1)}" fill="${TEAL}" font-size="9.5">${fmt(run)}</text>`;
  const chart1 = `<svg viewBox="0 0 ${W} ${H1}" width="100%" style="display:block">${gridLines(H1)}${resetMarks}${bands1}${limitLine}${overlay7d}</svg>`;
  const legend1 = seriesKeys.map((k) => `<span class="lg" data-conv="${esc(k)}" data-label="${labelData(k)}"><i style="background:${colorOf(k)}"></i>${esc(labelFor(k))} <b>${fmt(totalOf(k))}</b></span>`).join('');

  // ── CHART 2: per-turn billed tokens over the timeline ──
  const H2 = 92, maxB = Math.max(...p.turns.map((t) => t.b), 1);
  const yB = (v: number) => H2 - 4 - (v / maxB) * (H2 - 4 - PADT);
  let billed = '';
  for (const tn of p.turns) { const x = xT(tn.t).toFixed(1); const c = tn.f === 1 ? RED : tn.f === 2 ? AMBER : TEAL; billed += `<line x1="${x}" y1="${(H2 - 4).toFixed(1)}" x2="${x}" y2="${yB(tn.b).toFixed(1)}" stroke="${c}" stroke-opacity="${tn.f ? 0.95 : 0.5}" stroke-width="1"/>`; }
  const chart2 = `<svg viewBox="0 0 ${W} ${H2}" width="100%" style="display:block">${gridLines(H2)}${billed}<text x="${W - PLOT_R + 4}" y="${(yB(maxB) + 4).toFixed(1)}" fill="#808090" font-size="9.5">${fmt(maxB)} billed</text></svg>`;

  // ── CHART 3: context per conversation + reference lines + markers ──
  const H3 = 160, ctxMax = Math.max(...p.turns.map((t) => t.c), 1), ctxScale = Math.max(ctxMax, 1e6) * 1.04;
  const yCtx = (v: number) => H3 - 14 - (v / ctxScale) * (H3 - 14 - PADT - 8);
  let refs = '';
  for (const lvl of [250e3, 500e3, 750e3]) { const y = yCtx(lvl).toFixed(1); refs += `<line x1="${PLOT_L}" y1="${y}" x2="${W - PLOT_R}" y2="${y}" stroke="#222a38" stroke-width="1"/><text x="${W - PLOT_R + 4}" y="${(+y + 3)}" fill="#667" font-size="8.5">${fmt(lvl)}</text>`; }
  const y1m = yCtx(1e6).toFixed(1);
  refs += `<line x1="${PLOT_L}" y1="${y1m}" x2="${W - PLOT_R}" y2="${y1m}" stroke="${AMBER}" stroke-dasharray="6 4" stroke-width="1.1" stroke-opacity="0.75"/><text x="${W - PLOT_R + 4}" y="${(+y1m + 3)}" fill="${AMBER}" font-size="9">1M limit</text>`;
  const GAP_BREAK = 20 * 60e3;
  let lines3 = '', hits3 = '';
  top.forEach((id, i) => {
    const pts = p.turns.filter((t) => sessIdOf(t.s) === id).sort((a, b) => a.t - b.t);
    if (!pts.length) return;
    const color = RAINBOW[i % RAINBOW.length];
    const segs: typeof pts[] = []; let cur: typeof pts = [], prev: number | null = null;
    for (const t of pts) { if (prev !== null && t.t - prev > GAP_BREAK) { segs.push(cur); cur = []; } cur.push(t); prev = t.t; }
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      if (seg.length === 1) { lines3 += `<circle class="cline" data-conv="${esc(id)}" data-label="${labelData(id)}" cx="${xT(seg[0].t).toFixed(1)}" cy="${yCtx(seg[0].c).toFixed(1)}" r="1.7" fill="${color}"/>`; continue; }
      const poly = seg.map((t) => xT(t.t).toFixed(1) + ',' + yCtx(t.c).toFixed(1)).join(' ');
      lines3 += `<polyline class="cline" data-conv="${esc(id)}" data-label="${labelData(id)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-opacity="0.9" points="${poly}"/>`;
      hits3 += `<polyline class="chit" data-conv="${esc(id)}" data-label="${labelData(id)}" fill="none" stroke="transparent" stroke-width="9" points="${poly}"/>`;
    }
  });
  const evtLabel = (kind: string, tn: StatsPayload['turns'][0]) => `${kind} · ${labelFor(sessIdOf(tn.s))} · ${fmt(tn.c)} ctx · ${new Date(tn.t).toLocaleString()}`;
  let dots = '';
  for (const tn of p.turns) { if (tn.f === 1) dots += `<circle class="evt" data-conv="${esc(sessIdOf(tn.s))}" data-label="${esc(evtLabel('eviction', tn))}" cx="${xT(tn.t).toFixed(1)}" cy="${yCtx(tn.c).toFixed(1)}" r="2.8" fill="${RED}" fill-opacity="0.9"/>`; else if (tn.f === 2) dots += `<circle class="evt" data-conv="${esc(sessIdOf(tn.s))}" data-label="${esc(evtLabel('reload', tn))}" cx="${xT(tn.t).toFixed(1)}" cy="${yCtx(tn.c).toFixed(1)}" r="2.4" fill="${AMBER}" fill-opacity="0.75"/>`; }
  let events = '';
  for (const e of p.apiErrors) { const x = xT(e.t); events += `<path class="evt" data-conv="${esc(sessIdOf(e.s))}" data-label="${esc('API error · ' + labelFor(sessIdOf(e.s)) + ' · ' + new Date(e.t).toLocaleString())}" d="M${(x - 3.2).toFixed(1)},2 L${(x + 3.2).toFixed(1)},2 L${x.toFixed(1)},8 Z" fill="${RED}"/>`; }
  for (const g of p.images) { const id = sessIdOf(g.s); const s = sess[g.s]; const col = topSet.has(id) ? colorOf(id) : VIOLET; const lab = `${g.n} image${g.n === 1 ? '' : 's'} · ${labelFor(id)} · click to view`; events += imgIcon(xT(g.bucket), 8, g.n, col, `class="evt imgmark" data-conv="${esc(id)}" data-label="${esc(lab)}" data-slug="${esc(s?.slug ?? '')}" data-session="${esc(s?.id ?? '')}" data-bucket="${g.bucket}"`); }
  const chart3 = `<svg viewBox="0 0 ${W} ${H3}" width="100%" style="display:block">${gridLines(H3)}${refs}${lines3}${dots}${events}${hits3}</svg>`;

  // ── tool-result context + tables ──
  const maxTok = Math.max(...p.tools.map((r) => r.resultTokens), 1);
  const niceName = (n: string) => n.startsWith('mcp__') ? n.replace(/^mcp__/, '').replace('__', '·') : n;
  const toolBars = p.tools.map((r, i) => { const y = 4 + i * 19, w = (r.resultTokens / maxTok) * (W - 360); return `<rect x="190" y="${y}" width="${Math.max(w, 1).toFixed(1)}" height="13" rx="2" fill="${r.mcp ? ACCENT : '#3a4453'}"/><text x="184" y="${y + 11}" text-anchor="end" fill="#ccd" font-size="10.5">${esc(niceName(r.name))}</text><text x="${(196 + Math.max(w, 1)).toFixed(1)}" y="${y + 11}" fill="#808090" font-size="9.5">${fmt(r.resultTokens)}·${r.calls}×</text>`; }).join('');
  const chartTools = `<svg viewBox="0 0 ${W} ${p.tools.length * 19 + 8}" width="100%">${toolBars}</svg>`;
  const usedServers = new Set(p.tools.filter((t) => t.mcp).map((t) => t.name.split('__')[1]));
  const serverRows = [...usedServers].sort().map((s) => { const calls = p.tools.filter((t) => t.name.startsWith('mcp__' + s + '__')).reduce((a, t) => a + t.calls, 0); return `<tr><td>${esc(s)}</td><td><span style="color:${TEAL}">●</span></td><td style="text-align:right">${calls || '—'}</td></tr>`; }).join('') || '<tr><td colspan=3 style="color:#808090">none used</td></tr>';
  const agentRows = ['claude', 'codex', 'gemini'].map((a) => `<tr><td>${a}</td><td style="text-align:right">${p.consults[a] || 0}</td></tr>`).join('');

  const misses = p.turns.filter((t) => t.f === 1).length, reloads = p.turns.filter((t) => t.f === 2).length;
  const extra = p.turns.filter((t) => t.f === 1).reduce((s, t) => s + t.c * 0.9, 0);
  const kpis: Array<[string, string | number]> = [['API turns', p.turns.length], ['Total tok', fmt(p.totalTokens)], ['Convos', sess.length], ['Evictions', `${misses} (${(misses / p.turns.length * 100).toFixed(1)}%)`], ['Reloads', reloads], ['Extra/evict', fmt(extra)], ['Tool tok', fmt(p.toolResultTokens)], ['MCP tok', fmt(p.mcpResultTokens)], ['API errors', p.apiErrors.length], ['Images', p.imageCount]];

  return `<div class="kpis">${kpis.map(([k, v]) => `<div class="kpi"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('')}</div>
<div class="tsstack">
  <div class="card"><h2>Token usage — 5h blocks (left axis, stacked by conversation) + 7-day cumulative (right axis)</h2>
    <div class="row-sub"><b>Left:</b> stacked 5h-block usage (resets each rolling block — <span style="color:${TEAL}">teal verticals</span>); <span style="color:${RED}">red dashes</span> = 5h limit. <b>Right:</b> <span style="color:${TEAL}">teal curve</span> = cumulative toward the 7-day limit. Limits are placeholders until live values are wired.</div>${chart1}
    <div class="legend">${legend1}</div></div>
  <div class="card mid"><h2>Per-turn billed tokens (cache_read excluded)</h2><div class="row-sub"><span style="color:${TEAL}">teal</span> normal · <span style="color:${RED}">red</span> eviction · <span style="color:${AMBER}">amber</span> reload</div>${chart2}</div>
  <div class="card mid"><h2>Context size per conversation — grow, then compaction resets it</h2>
    <div class="row-sub">Lines break across idle gaps (resume). Gridlines 250/500/750k · <span style="color:${AMBER}">amber = 1M limit</span>. Clickable: <span style="color:${RED}">● eviction</span> · <span style="color:${AMBER}">● reload</span> · <span style="color:${RED}">▼ API error</span> · picture icon (line-colored) = images, <b>click to view</b>.</div>${chart3}</div>
  <div class="axis">${axisSvg}</div>
</div>
<div class="grid2">
  <div class="card"><h2>Tool-result context</h2><div class="row-sub"><span style="color:${ACCENT}">orange = MCP</span>, gray = built-in.</div>${chartTools}</div>
  <div class="card"><h2>MCP servers &amp; agent consults</h2><div class="grid2"><table><tr><td>server</td><td>used</td><td style="text-align:right">calls</td></tr>${serverRows}</table><table><tr><td>agent</td><td style="text-align:right">consults</td></tr>${agentRows}</table></div></div>
</div>`;
}

// ── interactivity ────────────────────────────────────────────
function wire(body: HTMLElement): void {
  const tip = document.getElementById('stats-tip') || (() => { const d = document.createElement('div'); d.id = 'stats-tip'; document.body.appendChild(d); return d; })();
  const all = [...body.querySelectorAll('[data-conv]')] as HTMLElement[];
  const over = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement; const c = el.getAttribute('data-conv'); const lab = el.getAttribute('data-label');
    all.forEach((o) => { const same = o.getAttribute('data-conv') === c; o.classList.toggle('hl', same); o.classList.toggle('dim', !same); });
    if (lab) { tip.textContent = lab; tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; }
  };
  const out = () => { tip.style.display = 'none'; all.forEach((o) => o.classList.remove('hl', 'dim')); };
  all.forEach((el) => { el.addEventListener('mousemove', over); el.addEventListener('mouseleave', out); });
  body.querySelectorAll('[data-imgs], .imgmark').forEach((el) => el.addEventListener('click', async () => {
    const slug = el.getAttribute('data-slug') || '', session = el.getAttribute('data-session') || '', bucket = Number(el.getAttribute('data-bucket')) || 0;
    openLightbox(await fetchBucketImages(slug, session, bucket));
  }));
}

function openLightbox(uris: string[]): void {
  const lb = document.getElementById('lb'); const wrap = document.getElementById('lb-imgs');
  if (!lb || !wrap) return;
  wrap.innerHTML = uris.length ? uris.map((u) => `<img src="${u}">`).join('') : '<div class="lb-note">No images found for this turn.</div>';
  lb.classList.add('open');
}

// ── sync (called on every render; shows when the cockpit Stats tab is active) ──
let lastDays = -1, loading = false;
export function syncStats(): void {
  const st = getState();
  const cp = st.ui.cockpit;
  const show = cp.open && cp.tab === 'stats' && !st.ui.selectedProject && !st.search.query.trim();
  const root = document.getElementById('stats');
  if (root) root.classList.toggle('open', show);
  if (!show) return;
  const body = document.getElementById('stats-body');
  if (!body) return;
  if (cp.statsDays !== lastDays && !loading) {
    loading = true;
    if (!body.innerHTML || body.dataset.days !== String(cp.statsDays)) body.innerHTML = '<div class="stats-empty">Loading usage…</div>';
    fetchStats(cp.statsDays).then((p) => {
      lastDays = cp.statsDays; body.dataset.days = String(cp.statsDays);
      body.innerHTML = buildBody(p); wire(body);
    }).catch(() => { body.innerHTML = '<div class="stats-empty">Failed to load stats.</div>'; })
      .finally(() => { loading = false; });
  }
}

// lightbox close (bound once)
document.addEventListener('click', (e) => {
  const lb = document.getElementById('lb'); if (!lb || !lb.classList.contains('open')) return;
  const t = e.target as HTMLElement;
  if (t === lb || t.classList.contains('lb-close')) lb.classList.remove('open');
});
