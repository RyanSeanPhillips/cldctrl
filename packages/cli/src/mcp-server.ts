/**
 * MCP (Model Context Protocol) server for cldctrl.
 * Exposes project data and session management as tools that Claude Code
 * conversations can use. Runs as a standalone stdio process — no TUI/Ink.
 *
 * Tools:
 * - list_projects: all projects with name, path, alias
 * - get_project_context: sessions, git, commits, issues for one project
 * - get_active_sessions: cross-project active/idle session list
 * - launch_session: open a new Claude Code terminal window
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { VERSION } from './constants.js';
import { loadConfig } from './config.js';
import { buildProjectListFast, buildProjectList } from './core/projects.js';
import { getRecentSessions } from './core/sessions.js';
import { getGitStatus, getRecentCommits } from './core/git.js';
import { getIssues, isGhAvailable } from './core/github.js';
import { getActiveClaudeProcesses } from './core/processes.js';
import { launchAndTrack } from './core/launcher.js';
import { readDaemonCache } from './core/background.js';
import { normalizePathForCompare } from './core/platform.js';
import { log, initLogger } from './core/logger.js';
import type { Config, Project } from './types.js';

// ── Project resolution ─────────────────────────────────────

/**
 * Resolve a project by name, alias, or path.
 * Returns the matched project or null.
 */
function resolveProject(
  config: Config,
  projects: Project[],
  identifier: string,
): Project | null {
  const lower = identifier.toLowerCase();

  // Check aliases first
  for (const cp of config.projects) {
    if (cp.alias && cp.alias.toLowerCase() === lower) {
      const found = projects.find(
        (p) => normalizePathForCompare(p.path) === normalizePathForCompare(cp.path),
      );
      if (found) return found;
    }
  }

  // Exact name match
  for (const p of projects) {
    if (p.name.toLowerCase() === lower) return p;
  }

  // Path match
  for (const p of projects) {
    if (normalizePathForCompare(p.path) === normalizePathForCompare(identifier)) {
      return p;
    }
  }

  // Unambiguous prefix
  const prefixMatches = projects.filter((p) => p.name.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];

  return null;
}

// ── Tool implementations ───────────────────────────────────

async function handleListProjects(): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);

  // Build alias lookup
  const aliasMap = new Map<string, string>();
  for (const cp of config.projects) {
    if (cp.alias) aliasMap.set(normalizePathForCompare(cp.path), cp.alias);
  }

  return projects.map((p) => ({
    name: p.name,
    path: p.path,
    alias: aliasMap.get(normalizePathForCompare(p.path)) || undefined,
    pinned: p.pinned || undefined,
  }));
}

async function handleGetProjectContext(args: { project: string }): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectList(config);
  const project = resolveProject(config, projects, args.project);
  if (!project) {
    return { error: `Project not found: "${args.project}". Use list_projects to see available projects.` };
  }

  const projectPath = project.path;
  const cache = readDaemonCache();

  // Fetch data — use daemon cache when available, fall back to live
  const [sessions, gitStatus, commits, issues] = await Promise.all([
    getRecentSessions(projectPath, 5),
    cache?.gitStatuses[projectPath]
      ? Promise.resolve(cache.gitStatuses[projectPath])
      : getGitStatus(projectPath),
    cache?.recentCommits?.[projectPath]
      ? Promise.resolve(cache.recentCommits[projectPath].slice(0, 10))
      : getRecentCommits(projectPath, 10),
    cache?.issues?.[projectPath]
      ? Promise.resolve(cache.issues[projectPath].slice(0, 5))
      : (isGhAvailable() ? getIssues(projectPath).then((i) => i.slice(0, 5)) : Promise.resolve([])),
  ]);

  return {
    project: { name: project.name, path: project.path },
    recentSessions: sessions.map((s) => ({
      id: s.id,
      summary: (s.richSummary || s.summary || '').slice(0, 100),
      date: s.dateLabel,
      messages: s.stats?.messages ?? 0,
      gitBranch: s.gitBranch || undefined,
    })),
    git: gitStatus
      ? {
          branch: gitStatus.branch,
          dirty: gitStatus.dirty,
          ahead: gitStatus.ahead,
          behind: gitStatus.behind,
        }
      : null,
    recentCommits: (commits || []).map((c) => ({
      hash: c.hash.slice(0, 8),
      subject: c.subject.slice(0, 80),
      date: c.date,
    })),
    openIssues: (issues || []).map((i) => ({
      number: i.number,
      title: i.title.slice(0, 100),
      labels: i.labels,
    })),
  };
}

async function handleGetActiveSessions(): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectListFast(config);
  const knownPaths = projects.map((p) => p.path);

  // Build name lookup
  const nameMap = new Map<string, string>();
  for (const p of projects) {
    nameMap.set(normalizePathForCompare(p.path), p.name);
  }

  const sessions = await getActiveClaudeProcesses(knownPaths);

  return sessions.map((s) => ({
    project: nameMap.get(normalizePathForCompare(s.projectPath)) || s.projectPath,
    path: s.projectPath,
    sessionId: s.sessionId || undefined,
    status: s.idle ? 'idle' : 'active',
    lastActivity: s.lastActivity.toISOString(),
  }));
}

async function handleLaunchSession(args: {
  project: string;
  prompt?: string;
  resume?: string;
}): Promise<unknown> {
  const { config } = loadConfig();
  const projects = buildProjectList(config);
  const project = resolveProject(config, projects, args.project);
  if (!project) {
    return { error: `Project not found: "${args.project}". Use list_projects to see available projects.` };
  }

  const result = launchAndTrack({
    projectPath: project.path,
    isNew: !args.resume,
    sessionId: args.resume,
    prompt: args.prompt,
  });

  return {
    success: result.success,
    message: result.message,
    project: project.name,
    path: project.path,
  };
}

// ── Server setup ───────────────────────────────────────────

async function main(): Promise<void> {
  initLogger();

  const server = new Server(
    { name: 'cldctrl', version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Register tool list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_projects',
        description:
          'List all projects known to cldctrl with their names, filesystem paths, and aliases.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'get_project_context',
        description:
          'Get context for a project: recent sessions (with summaries), git status, recent commits, and open GitHub issues. Returns compact data (~1-2KB).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Project name, alias, or filesystem path',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_active_sessions',
        description:
          'List all active Claude Code sessions across all projects, with their status (active/idle) and last activity time.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'launch_session',
        description:
          'Launch a new Claude Code session in a separate terminal window for a project. Optionally pass a prompt to start the session with context (e.g., an implementation plan from this conversation).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            project: {
              type: 'string',
              description: 'Project name, alias, or filesystem path',
            },
            prompt: {
              type: 'string',
              description: 'Initial prompt/context to pass to the new session',
            },
            resume: {
              type: 'string',
              description: 'Session ID to resume instead of starting a new session',
            },
          },
          required: ['project'],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'list_projects':
          result = await handleListProjects();
          break;
        case 'get_project_context':
          result = await handleGetProjectContext(args as { project: string });
          break;
        case 'get_active_sessions':
          result = await handleGetActiveSessions();
          break;
        case 'launch_session':
          result = await handleLaunchSession(
            args as { project: string; prompt?: string; resume?: string },
          );
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      log('error', { function: 'mcp-tool', tool: name, message: String(err) });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', { message: 'cldctrl MCP server started' });
}

main().catch((err) => {
  process.stderr.write(`cldctrl MCP server fatal error: ${err}\n`);
  process.exit(1);
});
