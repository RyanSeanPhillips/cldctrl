/** Transient status toast (the #toast element in the shell). Shared so modules
 *  outside main.ts (cockpit tiles, dock) can surface feedback without a cycle. */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
