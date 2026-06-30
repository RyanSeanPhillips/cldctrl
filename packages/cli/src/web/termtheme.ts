/**
 * Shared xterm theme builder. Reads the active dashboard CSS variables so any
 * embedded terminal (cockpit tiles, the CTRL control tile, future pop-outs) matches
 * whichever dashboard theme is selected. Extracted out of the old agent dock so the
 * dock subsystem can be retired without breaking the cockpit's terminals.
 */

/** Build an xterm theme from the active CSS variables so the terminal matches
 *  whichever dashboard theme is selected. */
export function termTheme(): Record<string, string> {
  const cs = getComputedStyle(document.body);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  const theme = document.documentElement.getAttribute('data-theme') || '';
  const light = theme === 'daylight' || theme === 'paper';
  const base: Record<string, string> = {
    background: v('--surface-1', '#0d121d'),
    foreground: v('--text', '#e4e8ef'),
    cursor: v('--accent', '#e87632'),
    cursorAccent: v('--surface-1', '#0d121d'),
    // accent-soft (12%) is too faint for selected TEXT — use a stronger wash.
    selectionBackground: light ? 'rgba(224,101,31,0.30)' : 'rgba(232,118,50,0.34)',
    green: v('--success', '#2dd4bf'), brightGreen: v('--success', '#2dd4bf'),
    blue: v('--info', '#4f9cff'), brightBlue: v('--info', '#4f9cff'),
    yellow: v('--warn', '#f59e0b'), brightYellow: v('--warn', '#f59e0b'),
    red: v('--crit', '#ef4444'), brightRed: v('--crit', '#ef4444'),
  };
  // xterm's default black/white/cyan/magenta are tuned for dark backgrounds; on a
  // light terminal the "dim" (brightBlack) text used by CLIs goes near-invisible.
  // Map the full palette per theme so secondary/dim text stays readable.
  if (light) {
    return {
      ...base,
      // brightBlack is the "dim" color CLIs use for secondary/selected-option text;
    // --text-muted (~#5b6678) is too light on white (≈5.8:1) and reads washed-out,
    // so use a darker slate so dim terminal text stays legible on light themes.
    black: v('--text', '#1a2230'), brightBlack: '#475164',
      white: v('--text-secondary', '#46536b'), brightWhite: v('--text', '#1a2230'),
      cyan: '#0e7490', brightCyan: '#0e7490', magenta: '#a21caf', brightMagenta: '#a21caf',
    };
  }
  return {
    ...base,
    black: '#0d121d', brightBlack: '#64748b',
    white: '#cfd6e2', brightWhite: '#ffffff',
    cyan: '#22d3ee', brightCyan: '#22d3ee', magenta: '#c084fc', brightMagenta: '#c084fc',
  };
}
