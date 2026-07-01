/** Theme switching. Themes are CSS-variable sets selected via a data-theme
 *  attribute on <html>; the choice persists in localStorage. The agent dock
 *  (xterm) listens for the 'themechange' event to re-theme the terminal. */

export const THEMES = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'daylight', label: 'Daylight' },
  { id: 'paper', label: 'Paper' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const KEY = 'cldctrl-theme';

export function currentTheme(): ThemeId {
  const t = localStorage.getItem(KEY);
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'daylight';
}

export function applyTheme(id: ThemeId): void {
  // 'midnight' is the :root default — represented by the absence of the attr.
  if (id === 'midnight') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem(KEY, id);
  // Tint the OS titlebar to match: Chromium app windows (and installed PWAs)
  // read the theme-color meta LIVE, so the window chrome melds with the active
  // theme instead of staying a mismatched default gray.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#070a10';
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = bg;
  window.dispatchEvent(new CustomEvent('themechange'));
}

export function initTheme(): void {
  applyTheme(currentTheme());
}
