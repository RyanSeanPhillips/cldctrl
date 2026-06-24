/**
 * Make file paths in terminal output clickable. Registers an xterm link provider
 * that detects path-like tokens; click → open the file (VS Code), Ctrl/Cmd+click
 * → reveal its location (Explorer). Relative paths are resolved against the
 * tile's project cwd. Server validates the path is inside a known project.
 */
import { postReveal } from './api.js';
import { toast } from './toast.js';

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
  const open = (raw: string, target: 'code' | 'explorer') => {
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
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text))) {
        const raw = m[0].replace(/[).,:;]+$/, ''); // trim trailing punctuation
        if (raw.length < 3) continue;
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + raw.length, y } },
          text: raw,
          activate: (ev: MouseEvent) => open(raw, ev.ctrlKey || ev.metaKey ? 'explorer' : 'code'),
        });
      }
      cb(links.length ? links : undefined);
    },
  });
}
