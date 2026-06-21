/** Small formatting helpers shared across components. */

/** Compact token/number formatting: 1.2M, 35k, 920. */
export function tok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

/** Relative time from an ISO string: "8s ago", "18m ago", "3h ago", "2d ago". */
export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1e3;
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

/** Duration in ms → "26m", "3h 18m". */
export function dur(ms: number): string {
  const m = Math.round(ms / 6e4);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/** Turns-per-request ratio (matches the TUI's T/R column). */
export function turnsPerReq(assistantTurns: number, messages: number): string {
  return (assistantTurns / Math.max(1, messages)).toFixed(1);
}

/** Clamp a number to [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
