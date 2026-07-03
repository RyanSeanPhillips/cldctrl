/**
 * Markdown → compilable LaTeX beside the source file, via pandoc. Shared by the
 * dashboard endpoint (/api/latex-convert, notepad dropdown) and the MCP
 * `convert_to_latex` tool — so both the operator and any agent in a session can
 * run the same deterministic conversion. When pandoc isn't installed the caller
 * falls back to having the agent write the .tex itself (often better for real
 * papers — it can match the document's conventions).
 */

import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { isCommandAvailable, normalizePathForCompare } from './platform.js';
import { loadConfig, getConfigDir } from '../config.js';
import { buildProjectListFast } from './projects.js';

/**
 * Only allow conversion of files the dashboard may already touch: inside a known
 * project or the scratch dir. Prevents a prompt-injected agent (via the MCP tool)
 * from writing a .tex to an arbitrary path on disk.
 */
export function isConvertiblePath(src: string): boolean {
  if (!src) return false;
  const np = normalizePathForCompare(src).replace(/\\/g, '/').replace(/\/+$/, '');
  const under = (root: string) => { const r = normalizePathForCompare(root).replace(/\\/g, '/').replace(/\/+$/, ''); return np === r || np.startsWith(r + '/'); };
  try { if (under(path.join(getConfigDir(), 'scratch'))) return true; } catch { /* ignore */ }
  try {
    const { config } = loadConfig();
    for (const p of buildProjectListFast(config)) if (under(p.path)) return true;
  } catch { /* ignore */ }
  return false;
}

export interface LatexResult {
  ok: boolean;
  texPath?: string;
  engine?: 'pandoc';
  pandocMissing?: boolean;
  error?: string;
}

export function convertMarkdownToLatex(src: string): LatexResult {
  if (!src || !/\.(md|markdown|txt)$/i.test(src)) return { ok: false, error: 'Not a markdown/text file (.md/.markdown/.txt)' };
  if (!isConvertiblePath(src)) return { ok: false, error: 'Path is not inside a known project or the scratch dir' };
  if (!fs.existsSync(src)) return { ok: false, error: 'File not found: ' + src };
  if (!isCommandAvailable('pandoc')) return { ok: false, pandocMissing: true };
  const texPath = src.replace(/\.(md|markdown|txt)$/i, '') + '.tex';
  try {
    const r = spawn.sync('pandoc', [src, '-f', 'markdown', '-t', 'latex', '--standalone', '-o', texPath],
      { stdio: 'ignore', timeout: 20_000 });
    if (r.status === 0 && fs.existsSync(texPath)) return { ok: true, texPath, engine: 'pandoc' };
    return { ok: false, error: `pandoc failed (exit ${r.status ?? 'signal'})` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
