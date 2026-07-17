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

const MISS_BEFORE_OVERLAY = 2;      // ~6–8s of failures before we show anything
const MISS_BEFORE_FAILURE = 20;     // ~60s → the server isn't coming back on its own

/** Call on each SUCCESSFUL overview poll with the payload's instanceId. */
export function onOverview(instanceId: string | undefined): void {
  if (reloading) return;
  const recovered = misses >= MISS_BEFORE_OVERLAY; // an overlay was showing
  misses = 0;

  if (instanceId) {
    if (known && instanceId !== known) { triggerReload(); return; } // server replaced
    if (!known) known = instanceId;                                 // first observation
    // else: same instance — no restart, even if there was a brief blip
  } else if (recovered) {
    // Legacy server (no instanceId marker) that just returned from an outage:
    // it bounced (or another process took the port) — reload to resync.
    triggerReload(); return;
  }
  hideOverlay();
}

/** Call on each FAILED overview poll (fetch threw / non-200). */
export function onOverviewError(): void {
  if (reloading) return;
  misses++;
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

type Mode = 'reconnecting' | 'updating' | 'failed';

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
  const spinner = mode === 'failed'
    ? '<div style="font-size:28px">⚠️</div>'
    : '<div style="width:34px;height:34px;border:3px solid #2a2f3a;border-top-color:#e87632;border-radius:50%;animation:cldctrl-spin 0.8s linear infinite"></div>';
  const title = mode === 'reconnecting' ? 'Reconnecting…'
    : mode === 'updating' ? 'Updating…'
    : 'Dashboard server didn’t come back';
  const sub = mode === 'reconnecting' ? 'Waiting for the dashboard server to come back.'
    : mode === 'updating' ? 'The server restarted — reloading to load the latest version.'
    : 'It may have failed to restart. Retry, or start it again from a terminal with <code style="color:#e87632">cc</code>.';
  overlayEl.innerHTML =
    spinner +
    `<div style="font-size:16px;color:#eee;font-weight:600">${title}</div>` +
    `<div style="max-width:420px;color:#9aa">${sub}</div>` +
    (mode === 'failed'
      ? '<button id="cldctrl-lifecycle-retry" style="margin-top:6px;padding:7px 16px;background:#e87632;color:#06080d;border:none;border-radius:6px;font-weight:600;cursor:pointer">Retry</button>'
      : '');
  if (mode === 'failed') {
    const btn = overlayEl.querySelector('#cldctrl-lifecycle-retry');
    btn?.addEventListener('click', () => { try { location.reload(); } catch { /* ignore */ } });
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
