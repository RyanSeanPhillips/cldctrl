/**
 * Conversation analysis: scans session transcripts across projects
 * to suggest new skills (slash commands) and project memories.
 * Uses `claude --print` with Haiku for AI-powered pattern detection.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSessionDir, getProjectSlug } from './projects.js';
import { extractTranscript } from './summaries.js';
import { runClaudePrint } from './claude-cli.js';
import { log } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export interface SkillSuggestion {
  name: string;           // command name
  description: string;
  evidence: string[];     // session excerpts
  promptDraft: string;    // draft .md content
}

export interface MemorySuggestion {
  project: string;
  category: 'convention' | 'preference' | 'architecture' | 'workflow';
  content: string;
  evidence: string[];
}

export interface AnalysisResult {
  skills: SkillSuggestion[];
  memories: MemorySuggestion[];
}

// ── Transcript collection ────────────────────────────────────

interface SessionFile {
  path: string;
  mtimeMs: number;
}

/**
 * Get the N most recent JSONL session files for a project.
 */
function getRecentSessionFiles(projectPath: string, count: number): SessionFile[] {
  const sessionDir = getSessionDir(projectPath);
  if (!fs.existsSync(sessionDir)) return [];

  try {
    return fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { path: filePath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, count);
  } catch {
    return [];
  }
}

/**
 * Collect transcripts from recent sessions across a project.
 */
function collectTranscripts(projectPath: string, sessionCount: number): string[] {
  const files = getRecentSessionFiles(projectPath, sessionCount);
  const transcripts: string[] = [];

  for (const file of files) {
    const transcript = extractTranscript(file.path);
    if (transcript) {
      transcripts.push(transcript);
    }
  }

  return transcripts;
}

// ── Analysis ─────────────────────────────────────────────────

const ANALYSIS_PROMPT = (projectName: string, transcripts: string) => `Analyze these Claude Code session transcripts from project "${projectName}".

Identify:
1. SKILL SUGGESTIONS: Repeated user request patterns (2+ occurrences across sessions) that could become reusable slash commands (~/.claude/commands/*.md). Focus on specific, actionable patterns — not generic requests like "fix bug" or "write code".

2. MEMORY SUGGESTIONS: Project-specific conventions, preferences, or architecture decisions that should be remembered in CLAUDE.md. Look for things the user corrects or re-explains.

Return ONLY valid JSON (no markdown fencing):
{
  "skills": [
    {
      "name": "command-name",
      "description": "What this command does",
      "evidence": ["brief excerpt showing the pattern"],
      "promptDraft": "The full prompt text for the .md file"
    }
  ],
  "memories": [
    {
      "category": "convention|preference|architecture|workflow",
      "content": "The convention or preference to remember",
      "evidence": ["brief excerpt showing this"]
    }
  ]
}

If no clear patterns found, return {"skills":[],"memories":[]}.

Transcripts:
${transcripts}`;

/**
 * Parse JSON response from Claude, handling potential markdown fencing.
 */
function parseAnalysisResponse(response: string): { skills: SkillSuggestion[]; memories: Omit<MemorySuggestion, 'project'>[] } {
  // Strip markdown code fences if present
  let json = response.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(json);
    return {
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    };
  } catch (err) {
    log('error', { function: 'parseAnalysisResponse', message: String(err) });
    return { skills: [], memories: [] };
  }
}

/**
 * Analyze a single project's sessions.
 */
export async function analyzeProject(
  projectPath: string,
  projectName: string,
  sessionCount = 10,
): Promise<AnalysisResult> {
  const transcripts = collectTranscripts(projectPath, sessionCount);
  if (transcripts.length === 0) {
    return { skills: [], memories: [] };
  }

  // Batch all transcripts with separators (cap total size)
  const MAX_CHARS = 30_000;
  let combined = '';
  for (let i = 0; i < transcripts.length; i++) {
    const section = `\n--- Session ${i + 1} ---\n${transcripts[i]}`;
    if (combined.length + section.length > MAX_CHARS) break;
    combined += section;
  }

  const prompt = ANALYSIS_PROMPT(projectName, combined);
  const response = await runClaudePrint(prompt, 120_000);
  const parsed = parseAnalysisResponse(response);

  return {
    skills: parsed.skills,
    memories: parsed.memories.map(m => ({
      ...m,
      project: projectName,
    })),
  };
}

// ── Save suggestions ─────────────────────────────────────────

/**
 * Save a skill suggestion as a command .md file.
 */
export function saveSkill(skill: SkillSuggestion): string {
  const commandsDir = path.join(os.homedir(), '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  // Sanitize: strip path separators and traversal sequences
  const safeName = skill.name.replace(/[/\\]/g, '-').replace(/\.\./g, '');
  if (!safeName) throw new Error('Invalid skill name');

  const filePath = path.join(commandsDir, `${safeName}.md`);
  // Verify resolved path stays within commandsDir
  if (!path.resolve(filePath).startsWith(path.resolve(commandsDir))) {
    throw new Error('Invalid skill name');
  }

  const content = `---\ndescription: ${skill.description}\n---\n\n${skill.promptDraft}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Append a memory suggestion to a project's CLAUDE.md.
 */
export function saveMemory(memory: MemorySuggestion, projectPath: string): string {
  const claudeDir = path.join(projectPath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const filePath = path.join(claudeDir, 'CLAUDE.md');
  const entry = `\n## ${memory.category}\n${memory.content}\n`;

  fs.appendFileSync(filePath, entry, 'utf-8');
  return filePath;
}
