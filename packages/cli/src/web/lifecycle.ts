/**
 * Server-restart detection + recovery for the dashboard page.
 *
 * The server stamps a random `instanceId` into /api/overview at each process
 * start. This page remembers the first one it sees; if a later poll reports a
 * DIFFERENT instanceId, the server was replaced (a `cc restart`, an idle-exit +
 * relaunch, or a crash+respawn) and this page — with its now-stale JS/CSS bundle
 * and dead WebSockets — must reload to resync against the new process. That's
 * what makes `cc restart` from a terminal "just work" in an already-open window,
 * and it's how a fresh build actually reaches the screen.
 *
 * When polls start FAILING the server is (probably) mid-restart: after a couple
 * of misses we show a "reconnecting" overlay and let the existing 3s poll keep
 * probing. Recovery rules on the next SUCCESSFUL poll:
 *   - different instanceId  → reload (new process, maybe new build)
 *   - same instanceId       → just a blip; dismiss the overlay, no reload
 *   - no instanceId (legacy server) but we were in an outage → reload (it bounced)
 * We only ever reload after a successful fetch, so we never reload into a server
 * that's still down. A long outage escalates to a manual-retry failure state.
 */

let known: string | null = null;   // first instanceId observed this page-load
let reloading = false;              // guard so we trigger exactly one reload
let misses = 0;                     // consecutive failed polls
let overlayEl: HTMLElement | null = null;
let manualMode: 'restarting' | 'stopping' | null = null; // user pressed Restart/Stop
let restartStartedAt = 0;           // when Restart was pressed (ms) — bounds the wait
// A declared failure is LATCHED: it waits for the user's Retry/Keep-using-it and
// is never silently replaced. Without this, later polls flip the dialog back to
// "Reconnecting…" (miss count is low) or hide it entirely on the next success —
// both of which yank the decision away mid-click.
let terminalFailure = false;

const MISS_BEFORE_OVERLAY = 2;      // ~6–8s of failures before we show anything
const MISS_BEFORE_FAILURE = 20;     // ~60s → the server isn't coming back on its own
// A restart normally completes in 2–4s. Two independent escape hatches, because a
// restart can fail in two opposite ways and BOTH used to strand the page on an
// eternal "Updating…" spinner with no way out but closing the window:
//   - the server went down and no successor came up  → polls keep failing
//   - the restart never took (e.g. stop-failed)      → polls keep SUCCEEDING, same id
const RESTART_DEAD_MS = 30_000;     // down this long → it isn't coming back on its own
const RESTART_NOOP_MS = 15_000;     // still the same process after this → it never bounced

/** The user pressed Restart in the power menu: show immediate feedback and keep
 *  the "Updating…" message steady while the server bounces. The reload still
 *  fires from onOverview when the new instanceId appears. */
export function announceRestarting(): void {
  if (reloading) return;
  manualMode = 'restarting';
  restartStartedAt = Date.now();
  showOverlay('updating');
}

/** The restart was refused before it began (demo mode, or the server couldn't
 *  spawn the supervisor). Nothing is bouncing, so drop the overlay immediately
 *  instead of leaving a spinner up for the escalation timeout to clean up. */
export function announceRestartAborted(): void {
  if (reloading) return;
  manualMode = null;
  restartStartedAt = 0;
  misses = 0;
  terminalFailure = false;
  hideOverlay();
}

/** The user pressed Stop: the server is meant to stay down, so freeze the page
 *  on a terminal "stopped" state and never auto-reload. */
export function announceStopping(): void {
  manualMode = 'stopping';
  reloading = true; // blocks onOverview/onOverviewError — no reconnect attempts
  showOverlay('stopped');
}

/** Call on each SUCCESSFUL overview poll with the payload's instanceId. */
export function onOverview(instanceId: string | undefined): void {
  if (reloading) return;
  const recovered = misses >= MISS_BEFORE_OVERLAY; // an overlay was showing
  misses = 0;

  if (instanceId) {
    if (known && instanceId !== known) { triggerReload(); return; } // server replaced
    if (!known) known = instanceId;                                 // first observation
    // Same instance while a manual restart is pending: for the first few seconds
    // that's just the old process not having exited yet. Past the grace window it
    // means the restart never happened (the supervisor failed to spawn, or the
    // stop timed out) — surface it instead of spinning forever on "Updating…".
    if (manualMode === 'restarting') {
      if (Date.now() - restartStartedAt > RESTART_NOOP_MS) { manualMode = null; showOverlay('restart-failed'); }
      return; // either way the overlay stays up — don't fall through to hideOverlay
    }
  } else if (recovered) {
    // Legacy server (no instanceId marker) that just returned from an outage:
    // it bounced (or another process took the port) — reload to resync.
    triggerReload(); return;
  }
  if (terminalFailure) return; // waiting on the user's choice — don't dismiss it for them
  manualMode = null;
  hideOverlay();
}

/** Call on each FAILED overview poll (fetch threw / non-200). */
export function onOverviewError(): void {
  if (reloading || terminalFailure) return;
  misses++;
  // A manual restart keeps the "Updating…" message steady rather than flipping
  // to "Reconnecting…" while the server is expectedly down for a few seconds —
  // but it is NOT allowed to wait forever. Past the budget the successor clearly
  // isn't coming, so fall through to the recoverable failure state (with Retry).
  if (manualMode === 'restarting') {
    if (Date.now() - restartStartedAt < RESTART_DEAD_MS) { showOverlay('updating'); return; }
    // Budget blown. Go STRAIGHT to the failure state — falling through would land
    // on "Reconnecting…" (miss count is still low) and strand the user again, just
    // with different wording.
    manualMode = null;
    showOverlay('failed');
    return;
  }
  if (misses >= MISS_BEFORE_FAILURE) showOverlay('failed');
  else if (misses >= MISS_BEFORE_OVERLAY) showOverlay('reconnecting');
}

function triggerReload(): void {
  reloading = true;
  showOverlay('updating');
  // Let the overlay paint, then reload. The bundle is served no-cache, so a
  // reload revalidates and picks up a rebuilt app.js/app.css.
  setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 600);
}

// ── overlay (inline-styled so it survives even if app.css didn't reload) ──────

type Mode = 'reconnecting' | 'updating' | 'failed' | 'stopped' | 'restart-failed';

function showOverlay(mode: Mode): void {
  if (!overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.id = 'cldctrl-lifecycle-overlay';
    overlayEl.setAttribute('role', 'status');
    overlayEl.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:14px', 'background:rgba(6,8,13,0.86)', 'backdrop-filter:blur(3px)',
      'color:#ccc', 'font:14px/1.5 system-ui,sans-serif', 'text-align:center', 'padding:24px',
    ].join(';');
    document.body.appendChild(overlayEl);
    ensureSpinKeyframes();
  }
  const stat = mode === 'failed' || mode === 'stopped' || mode === 'restart-failed';
  // Terminal states latch until the user acts (see `terminalFailure`).
  if (mode === 'failed' || mode === 'restart-failed') terminalFailure = true;
  const spinner = mode === 'failed' ? '<div style="font-size:28px">⚠️</div>'
    : mode === 'restart-failed' ? '<div style="font-size:28px">⚠️</div>'
    : mode === 'stopped' ? '<div style="font-size:28px">⏻</div>'
    : '<div style="width:34px;height:34px;border:3px solid #2a2f3a;border-top-color:#e87632;border-radius:50%;animation:cldctrl-spin 0.8s linear infinite"></div>';
  const title = mode === 'reconnecting' ? 'Reconnecting…'
    : mode === 'updating' ? 'Updating…'
    : mode === 'stopped' ? 'Dashboard stopped'
    : mode === 'restart-failed' ? 'Restart didn’t take'
    : 'Dashboard server didn’t come back';
  const sub = mode === 'reconnecting' ? 'Waiting for the dashboard server to come back.'
    : mode === 'updating' ? 'The server restarted — reloading to load the latest version.'
    : mode === 'stopped' ? 'The server was shut down. Start it again from a terminal with <code style="color:#e87632">cc</code>.'
    // restart-failed: the OLD server answered again, so nothing was lost — the
    // restart just didn't happen. Dismiss is safe and keeps the session intact.
    : mode === 'restart-failed' ? 'The dashboard is still running on the old version — your conversations are intact. Try again, or restart it from a terminal with <code style="color:#e87632">cc restart</code>.'
    : 'It may have failed to restart. Retry, or start it again from a terminal with <code style="color:#e87632">cc</code>.';
  const btns = mode === 'restart-failed'
    ? '<div style="display:flex;gap:8px;margin-top:6px">'
      + '<button id="cldctrl-lifecycle-retry" style="padding:7px 16px;background:#e87632;color:#06080d;border:none;border-radius:6px;font-weight:600;cursor:pointer">Try again</button>'
      + '<button id="cldctrl-lifecycle-dismiss" style="padding:7px 16px;background:transparent;color:#ccc;border:1px solid #3a4150;border-radius:6px;cursor:pointer">Keep using it</button>'
      + '</div>'
    : stat
      ? '<button id="cldctrl-lifecycle-retry" style="margin-top:6px;padding:7px 16px;background:#e87632;color:#06080d;border:none;border-radius:6px;font-weight:600;cursor:pointer">Retry</button>'
      : '';
  overlayEl.innerHTML =
    spinner +
    `<div style="font-size:16px;color:#eee;font-weight:600">${title}</div>` +
    `<div style="max-width:420px;color:#9aa">${sub}</div>` + btns;
  if (stat) {
    overlayEl.querySelector('#cldctrl-lifecycle-retry')
      ?.addEventListener('click', () => { try { location.reload(); } catch { /* ignore */ } });
    // "Keep using it": the server is alive and this page is still valid, so just
    // drop the overlay — no reload, nothing to recover.
    overlayEl.querySelector('#cldctrl-lifecycle-dismiss')
      ?.addEventListener('click', () => { misses = 0; manualMode = null; terminalFailure = false; hideOverlay(); });
  }
  overlayEl.style.display = 'flex';
}

function hideOverlay(): void {
  if (overlayEl) overlayEl.style.display = 'none';
}

let spinKeyframesAdded = false;
function ensureSpinKeyframes(): void {
  if (spinKeyframesAdded) return;
  spinKeyframesAdded = true;
  const style = document.createElement('style');
  style.textContent = '@keyframes cldctrl-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
}
