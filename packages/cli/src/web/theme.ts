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
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'midnight';
}

export function applyTheme(id: ThemeId): void {
  // 'midnight' is the :root default — represented by the absence of the attr.
  if (id === 'midnight') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem(KEY, id);
  window.dispatchEvent(new CustomEvent('themechange'));
}

export function initTheme(): void {
  applyTheme(currentTheme());
}
