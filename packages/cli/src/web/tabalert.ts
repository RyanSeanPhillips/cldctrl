/**
 * Tab attention: when a conversation needs you (the agent rang the bell, or it
 * produced output then went quiet) while you're on ANOTHER browser tab, flash
 * the title and badge the favicon so the cldctrl tab catches your eye. Clears
 * the moment you return to the tab.
 */
const NORMAL_TITLE = '⌃ CLD CTRL';
const ICON_NORMAL = '/favicon.svg';
const ICON_ALERT = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e87632"/>'
  + '<path d="M6.5 21.5 L16 11 L25.5 21.5" fill="none" stroke="#0b0e15" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<circle cx="24.5" cy="8" r="7.5" fill="#ff3b30" stroke="#fff" stroke-width="1.6"/></svg>');

let blink: ReturnType<typeof setInterval> | null = null;
let active = false;

function setIcon(href: string): void { const l = document.querySelector('link[rel="icon"]'); if (l) l.setAttribute('href', href); }

/** Signal that a conversation wants attention. No-op while the tab is focused. */
export function flagAttention(label = 'needs input'): void {
  if (!document.hidden || active) return; // only when you're looking elsewhere
  active = true;
  setIcon(ICON_ALERT);
  let on = false;
  blink = setInterval(() => { on = !on; document.title = on ? `● ${label}` : NORMAL_TITLE; }, 1000);
}

export function clearAttention(): void {
  if (!active) return;
  active = false;
  if (blink) { clearInterval(blink); blink = null; }
  document.title = NORMAL_TITLE;
  setIcon(ICON_NORMAL);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) clearAttention(); });
window.addEventListener('focus', clearAttention);
