/**
 * Make file paths in terminal output clickable. Registers an xterm link provider
 * that detects path-like tokens. Opening is MODIFIER-GATED so a stray click while
 * reading/selecting doesn't launch anything:
 *   Ctrl/Cmd+click       → SMART open: source/text files → VS Code (their OS
 *                          association is usually wrong or missing); everything
 *                          else (images, PDFs, HTML, docs…) → the OS default app.
 *   Ctrl/Cmd+Alt+click   → force the OS default app for any file type.
 *   Ctrl/Cmd+Shift+click → reveal in Explorer/Finder (right-click there for
 *                          "Open with…" when you want to pick the app).
 *   plain click          → just a hint toast.
 * IMAGE paths are special: hovering shows a floating thumbnail, a plain click
 * opens the in-app lightbox (viewing in-app is harmless — no modifier needed).
 * URLs (http/https) are clickable too: Ctrl/Cmd+click opens a new tab — the
 * pattern for "this needs a dev server/env": the agent runs it in ITS terminal
 * (which has the env) and prints the URL; the link is just the pointer.
 * Relative paths resolve against the tile's cwd — the WORKTREE dir for worktree
 * tiles (see worktreeCwd) — and the server validates the path is inside a known
 * project (and never shell-executes executables).
 */
import { postReveal } from './api.js';
import { toast } from './toast.js';
import { openLightbox } from './stats.js';

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);
function isImagePath(p: string): boolean {
  return IMG_EXTS.has((p.split('.').pop() ?? '').toLowerCase());
}
const URL_RE = /https?:\/\/[^\s"'<>|(){}\[\]]+/g;

/** The cwd a tile's relative paths resolve against. Worktree tiles run in
 *  <project>/.claude/worktrees/<branch-slug> — resolving against the main
 *  checkout would silently open the WRONG (main-branch) copy of the file.
 *  Slug rule mirrors core/worktree.ts. */
export function worktreeCwd(projectPath: string, worktree?: boolean, branch?: string): string {
  if (!worktree || !projectPath) return projectPath;
  const s = (branch || 'cockpit/session').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return projectPath.replace(/[\\/]+$/, '') + sep + '.claude' + sep + 'worktrees' + sep + s;
}

// ── hover thumbnail (one floating element, shared by all tiles) ──
let peekEl: HTMLImageElement | null = null;
function showPeek(src: string, ev: MouseEvent): void {
  if (!peekEl) {
    peekEl = document.createElement('img');
    peekEl.className = 'term-img-peek';
    peekEl.addEventListener('error', () => { if (peekEl) peekEl.style.display = 'none'; });
    document.body.appendChild(peekEl);
  }
  peekEl.src = src;
  peekEl.style.display = 'block';
  // Above the cursor when there's room, below otherwise; clamp into the viewport.
  const pad = 14, w = 260, h = 200;
  peekEl.style.left = Math.min(ev.clientX + pad, window.innerWidth - w - pad) + 'px';
  peekEl.style.top = (ev.clientY > h + 2 * pad ? ev.clientY - h - pad : ev.clientY + pad) + 'px';
}
function hidePeek(): void { if (peekEl) { peekEl.style.display = 'none'; peekEl.removeAttribute('src'); } }

// File types where "open" means EDIT: route to VS Code, not the OS association
// (on Windows .ts is an MPEG stream, .py may be the interpreter, .md often nothing).
// Everything outside this set shell-opens with the OS default app.
const EDITOR_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'md', 'markdown', 'txt', 'json', 'jsonl', 'jsonc', 'css', 'scss', 'less', 'toml', 'yaml', 'yml', 'ini',
  'conf', 'cfg', 'env', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'proto',
  'vue', 'svelte', 'xml', 'csv', 'log', 'lock', 'gitignore', 'dockerfile', 'makefile', 'tex',
]);
function opensInEditor(p: string): boolean {
  const base = p.split(/[\\/]/).pop() ?? '';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : base.toLowerCase();
  return EDITOR_EXTS.has(ext) || !base.includes('.'); // extensionless (Makefile, LICENSE) → editor
}

let lastHint = 0; // throttle the "Ctrl+Click" hint so rapid clicks don't stack toasts

// absolute Windows (C:\…), absolute POSIX (/…), or a path with a separator/extension
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>|(){}]+|\/[\w.@~/-]+\/[\w.@-]+\.[A-Za-z0-9]{1,10}|(?:\.{0,2}[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,10}|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|jsonl|css|html|txt|png|jpe?g|gif|svg|toml|ya?ml|sh|ps1|rs|go|java|c|cpp|h)\b)/g;

function absolutize(raw: string, projectPath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) return raw;
  if (!projectPath) return raw;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return projectPath.replace(/[\\/]+$/, '') + sep + raw.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
}

export function registerFileLinks(term: any, projectPath: string): void {
  if (!term?.registerLinkProvider) return;
  const open = (raw: string, target: 'code' | 'explorer' | 'default') => {
    const abs = absolutize(raw, projectPath);
    postReveal(abs, target).then((r) => { if (!r.ok) toast('✗ ' + (r.error || 'could not open ' + raw)); })
      .catch(() => toast('✗ open failed'));
  };
  term.registerLinkProvider({
    provideLinks(y: number, cb: (links: any[] | undefined) => void) {
      const line = term.buffer?.active?.getLine(y - 1);
      if (!line) { cb(undefined); return; }
      const text: string = line.translateToString(true);
      const links: any[] = [];
      // URLs first — and remember their spans so the path matcher below doesn't
      // re-match path-looking fragments INSIDE a URL (e.g. localhost:5173/x.html).
      const urlSpans: Array<[number, number]> = [];
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text))) {
        const raw = m[0].replace(/[).,:;]+$/, '');
        urlSpans.push([m.index, m.index + raw.length]);
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + raw.length, y } },
          text: raw,
          activate: (ev: MouseEvent) => {
            if (ev.ctrlKey || ev.metaKey) { window.open(raw, '_blank', 'noopener'); return; }
            const now = Date.now();
            if (now - lastHint > 2500) { lastHint = now; toast('Ctrl+Click to open the link in a new tab'); }
          },
        });
      }
      PATH_RE.lastIndex = 0;
      while ((m = PATH_RE.exec(text))) {
        const raw = m[0].replace(/[).,:;]+$/, ''); // trim trailing punctuation
        if (raw.length < 3) continue;
        const s = m.index, e = m.index + raw.length;
        if (urlSpans.some(([us, ue]) => s < ue && e > us)) continue; // inside a URL
        const img = isImagePath(raw);
        const imgSrc = () => '/api/image?path=' + encodeURIComponent(absolutize(raw, projectPath));
        links.push({
          range: { start: { x: s + 1, y }, end: { x: e, y } },
          text: raw,
          activate: (ev: MouseEvent) => {
            if (ev.ctrlKey || ev.metaKey) {
              const target = ev.shiftKey ? 'explorer'      // reveal (→ right-click "Open with…")
                : ev.altKey ? 'default'                    // force the OS default app
                : opensInEditor(raw) ? 'code' : 'default'; // smart: editor for source, OS app otherwise
              open(raw, target);
              return;
            }
            // plain click: images pop the in-app lightbox (harmless to view);
            // everything else teaches the gesture (throttled)
            if (img) { hidePeek(); openLightbox([imgSrc()]); return; }
            const now = Date.now();
            if (now - lastHint > 2500) { lastHint = now; toast('Ctrl+Click to open · Ctrl+Alt+Click default app · Ctrl+Shift+Click reveal'); }
          },
          hover: img ? (ev: MouseEvent) => showPeek(imgSrc(), ev) : undefined,
          leave: img ? () => hidePeek() : undefined,
        });
      }
      cb(links.length ? links : undefined);
    },
  });
}
