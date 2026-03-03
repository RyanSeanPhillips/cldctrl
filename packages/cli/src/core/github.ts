/**
 * GitHub issue fetching via `gh` CLI (execFile, array args).
 * Uses cross-spawn for Windows .cmd shim compatibility.
 */

import spawn from 'cross-spawn';
import { log } from './logger.js';
import { isCommandAvailable } from './platform.js';
import type { Issue } from '../types.js';

const GH_INSTALL_URL = 'https://cli.github.com/';

/**
 * Check if gh CLI is available.
 */
export function isGhAvailable(): boolean {
  return isCommandAvailable('gh');
}

/**
 * Run a gh command and return stdout.
 */
function runGh(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args[0]} failed (code ${code}): ${stderr}`));
    });

    // 15s timeout for network calls
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`gh ${args.join(' ')} timed out`));
    }, 15_000);
  });
}

/**
 * Fetch open issues for a project directory.
 * Returns empty array if gh is not available or repo has no remote.
 */
export async function getIssues(projectPath: string): Promise<Issue[]> {
  if (!isGhAvailable()) return [];

  try {
    const json = await runGh(
      [
        'issue', 'list',
        '--state', 'open',
        '--json', 'number,title,state,url,createdAt,labels',
        '--limit', '20',
      ],
      projectPath
    );

    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return [];

    return raw.map((issue: Record<string, unknown>) => ({
      number: issue.number as number,
      title: issue.title as string,
      state: issue.state as string,
      url: issue.url as string,
      createdAt: issue.createdAt as string,
      labels: ((issue.labels as Array<{ name: string }>) ?? []).map((l) => l.name),
    }));
  } catch (err) {
    log('error', { function: 'getIssues', message: String(err) });
    return [];
  }
}

/**
 * Get the gh CLI install URL for display.
 */
export function getGhInstallUrl(): string {
  return GH_INSTALL_URL;
}

/**
 * Sanitize an issue title for use in --prompt arg.
 * Whitelist regex, 200-char truncation.
 */
export function sanitizeIssueTitle(title: string): string {
  const safe = title.replace(/[^a-zA-Z0-9 \-_.,:;!?#()@/]/g, '');
  return safe.slice(0, 200);
}
