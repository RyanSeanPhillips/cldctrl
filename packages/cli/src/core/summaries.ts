/**
 * AI-generated rich session summaries via `claude --print`.
 * Extracts transcripts from JSONL, calls Haiku for summarization,
 * caches results persistently in rich-summaries.json per session dir.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import spawn from 'cross-spawn';
import pLimit from 'p-limit';
import { getSessionDir } from './projects.js';
import { getConfigDir } from '../config.js';
import { atomicWriteFile, issueKey } from './background.js';
import { getCleanEnv } from './launcher.js';
import { log } from './logger.js';
import { DEFAULTS } from '../constants.js';
import type { Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────

interface SummaryCacheEntry {
  summary: string;
  generatedAt: string;
  mtimeMs: number;
}

interface SummaryCache {
  [sessionId: string]: SummaryCacheEntry;
}

// ── Run Claude CLI ───────────────────────────────────────────

/**
 * Spawn `claude --print` with Haiku model and return trimmed output.
 * Uses array args (no shell) — same pattern as git.ts:runGit.
 */
function runClaude(prompt: string, timeout = 60_000): Promise<string> {
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

// ── Transcript extraction ────────────────────────────────────

/**
 * Extract a compact transcript from a JSONL session file.
 * Samples first 8 + last 8 messages for long sessions.
 * Each message truncated to ~300 chars.
 */
export function extractTranscript(filePath: string, maxMessages = 16): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > DEFAULTS.maxSessionFileSize) return '';

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const messages: Array<{ role: string; text: string }> = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        // User messages
        if (
          (parsed.type === 'user' || parsed.message?.type === 'user') &&
          (parsed.role === 'user' || parsed.message?.role === 'user')
        ) {
          const msg = parsed.message || parsed;
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            // Content blocks — extract text parts
            text = msg.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join(' ');
          }
          if (text) {
            messages.push({ role: 'User', text: text.slice(0, 300) });
          }
        }

        // Assistant messages
        if (
          (parsed.type === 'assistant' || parsed.message?.type === 'assistant') &&
          (parsed.role === 'assistant' || parsed.message?.role === 'assistant')
        ) {
          const msg = parsed.message || parsed;
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join(' ');
          }
          if (text) {
            messages.push({ role: 'Assistant', text: text.slice(0, 300) });
          }
        }
      } catch { /* skip unparseable lines */ }
    }

    if (messages.length === 0) return '';

    // Sample: first half + last half if too many
    const half = Math.floor(maxMessages / 2);
    let sampled: typeof messages;
    if (messages.length <= maxMessages) {
      sampled = messages;
    } else {
      sampled = [
        ...messages.slice(0, half),
        ...messages.slice(-half),
      ];
    }

    return sampled
      .map((m) => `${m.role}: ${m.text}`)
      .join('\n');
  } catch (err) {
    log('error', { function: 'extractTranscript', message: String(err) });
    return '';
  }
}

// ── Summary generation ───────────────────────────────────────

const SUMMARY_PROMPT_PREFIX = `Summarize this Claude Code session in 2-3 sentences. Describe what was being worked on, the approach, and current status. Be specific, not generic.\n\nTranscript:\n`;

/**
 * Generate a rich summary for a single session file.
 */
export async function generateSessionSummary(sessionFilePath: string): Promise<string> {
  const transcript = extractTranscript(sessionFilePath);
  if (!transcript) return '';

  const prompt = SUMMARY_PROMPT_PREFIX + transcript;
  return runClaude(prompt);
}

// ── Cache management ─────────────────────────────────────────

function getSummaryCachePath(sessionDir: string): string {
  return path.join(sessionDir, 'rich-summaries.json');
}

export function loadSummaryCache(sessionDir: string): SummaryCache {
  const cachePath = getSummaryCachePath(sessionDir);
  try {
    if (!fs.existsSync(cachePath)) return {};
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSummaryCache(sessionDir: string, cache: SummaryCache): void {
  atomicWriteFile(getSummaryCachePath(sessionDir), JSON.stringify(cache, null, 2) + '\n');
}

// ── Batch generation ─────────────────────────────────────────

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Generate missing/outdated summaries for all sessions in a project.
 * Skips sessions older than 14 days and those with up-to-date cached summaries.
 */
export async function generateMissingSummaries(
  projectPath: string,
  concurrency = 10,
  onProgress?: (sessionId: string, summary: string) => void,
): Promise<number> {
  const sessionDir = getSessionDir(projectPath);
  if (!fs.existsSync(sessionDir)) return 0;

  const now = Date.now();
  let jsonlFiles: Array<{ name: string; path: string; mtimeMs: number }>;
  try {
    jsonlFiles = fs.readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { name: f, path: filePath, mtimeMs: stat.mtimeMs };
      })
      .filter((f) => now - f.mtimeMs < MAX_AGE_MS);
  } catch {
    return 0;
  }

  if (jsonlFiles.length === 0) return 0;

  const cache = loadSummaryCache(sessionDir);
  const needsGeneration: typeof jsonlFiles = [];

  for (const file of jsonlFiles) {
    const sessionId = path.basename(file.name, '.jsonl');
    const cached = cache[sessionId];
    if (cached && cached.mtimeMs === file.mtimeMs) continue;
    needsGeneration.push(file);
  }

  if (needsGeneration.length === 0) return 0;

  const limit = pLimit(concurrency); // default 10 — claude handles parallel calls fine
  let generated = 0;

  await Promise.allSettled(
    needsGeneration.map((file) =>
      limit(async () => {
        const sessionId = path.basename(file.name, '.jsonl');
        try {
          const summary = await generateSessionSummary(file.path);
          if (summary) {
            cache[sessionId] = {
              summary,
              generatedAt: new Date().toISOString(),
              mtimeMs: file.mtimeMs,
            };
            generated++;
            onProgress?.(sessionId, summary);
          }
        } catch (err) {
          log('error', { function: 'generateMissingSummaries', sessionId, message: String(err) });
        }
      })
    )
  );

  if (generated > 0) {
    saveSummaryCache(sessionDir, cache);
  }

  return generated;
}

// ── Issue summary cache ───────────────────────────────────

interface IssueSummaryCacheEntry {
  summary: string;
  generatedAt: string;
}

interface IssueSummaryCache {
  [key: string]: IssueSummaryCacheEntry; // key: "repoPath#issueNumber"
}

function getIssueSummaryCachePath(): string {
  return path.join(getConfigDir(), 'issue-summaries.json');
}

export function loadIssueSummaryCache(): IssueSummaryCache {
  const cachePath = getIssueSummaryCachePath();
  try {
    if (!fs.existsSync(cachePath)) return {};
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveIssueSummaryCache(cache: IssueSummaryCache): void {
  atomicWriteFile(getIssueSummaryCachePath(), JSON.stringify(cache, null, 2) + '\n');
}

const ISSUE_SUMMARY_PROMPT_PREFIX = `Summarize this GitHub issue in 2-3 simple sentences. What's the problem and what needs to be done? Be specific based on the issue details.\n\n`;

/**
 * Generate an AI summary for a single issue.
 */
export async function generateIssueSummary(issue: Issue, _projectPath: string): Promise<string> {
  const labels = issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}.\n` : '';
  const body = issue.body ? issue.body.slice(0, 2000) : '(no description)';
  const prompt = `${ISSUE_SUMMARY_PROMPT_PREFIX}Issue #${issue.number}: ${issue.title}\n${labels}\n${body}`;
  return runClaude(prompt);
}

/**
 * Generate missing issue summaries for a project's issues.
 * Loads cache, skips already-summarized issues, generates in parallel.
 */
export async function generateMissingIssueSummaries(
  projectPath: string,
  issues: Issue[],
  concurrency = 2,
  onProgress?: (issueNumber: number, summary: string) => void,
): Promise<number> {
  if (issues.length === 0) return 0;

  const cache = loadIssueSummaryCache();
  const needsGeneration: Issue[] = [];

  for (const issue of issues) {
    const key = issueKey(projectPath, issue.number);
    if (cache[key]) continue;
    needsGeneration.push(issue);
  }

  if (needsGeneration.length === 0) return 0;

  const limiter = pLimit(concurrency);
  let generated = 0;

  await Promise.allSettled(
    needsGeneration.map((issue) =>
      limiter(async () => {
        try {
          const summary = await generateIssueSummary(issue, projectPath);
          if (summary) {
            const key = issueKey(projectPath, issue.number);
            cache[key] = {
              summary,
              generatedAt: new Date().toISOString(),
            };
            generated++;
            onProgress?.(issue.number, summary);
          }
        } catch (err) {
          log('error', { function: 'generateMissingIssueSummaries', issue: issue.number, message: String(err) });
        }
      })
    )
  );

  if (generated > 0) {
    saveIssueSummaryCache(cache);
  }

  return generated;
}
