/**
 * Shared Claude CLI invocation for AI-powered features.
 * Used by summaries.ts and analyzer.ts.
 */

import spawn from 'cross-spawn';
import { getCleanEnv } from './launcher.js';

/**
 * Spawn `claude --print` with Haiku model and return trimmed output.
 * Uses array args (no shell).
 */
export function runClaudePrint(prompt: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '--print',
      '-p', prompt,
      '--no-session-persistence',
      '--model', 'haiku',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getCleanEnv(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude --print failed (code ${code}): ${stderr}`));
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude --print timed out'));
    }, timeout);
  });
}
