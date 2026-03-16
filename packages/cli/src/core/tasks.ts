/**
 * Read Claude Code's task/todo progress for active sessions.
 * Sources:
 *   ~/.claude/todos/{sessionId}-agent-{agentId}.json
 *   ~/.claude/tasks/{sessionId}/{id}.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './platform.js';
import { log } from './logger.js';

export interface TodoItem {
  content: string;
  status: 'completed' | 'pending';
  activeForm?: string;
}

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];
  blockedBy: string[];
  activeForm?: string;
}

export interface SessionTasks {
  todos: TodoItem[];
  tasks: TaskItem[];
}

const EMPTY_TASKS: SessionTasks = { todos: [], tasks: [] };

// ── Cache by directory mtime ──────────────────────────

let _todosCache: { mtime: number; sessionId: string; todos: TodoItem[] } | null = null;
let _tasksCache: { mtime: number; sessionId: string; tasks: TaskItem[] } | null = null;

function getClaudeDir(): string {
  return path.join(getHomeDir(), '.claude');
}

function readTodos(sessionId: string): TodoItem[] {
  const todosDir = path.join(getClaudeDir(), 'todos');
  try {
    if (!fs.existsSync(todosDir)) return [];
    const stat = fs.statSync(todosDir);
    if (_todosCache && _todosCache.sessionId === sessionId && _todosCache.mtime === stat.mtimeMs) {
      return _todosCache.todos;
    }

    const files = fs.readdirSync(todosDir)
      .filter(f => f.startsWith(`${sessionId}-agent-`) && f.endsWith('.json'));

    const todos: TodoItem[] = [];
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(todosDir, file), 'utf-8'));
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (item && typeof item.content === 'string') {
              todos.push({
                content: item.content,
                status: item.status === 'completed' ? 'completed' : 'pending',
                activeForm: item.activeForm || undefined,
              });
            }
          }
        }
      } catch { /* skip corrupt file */ }
    }

    _todosCache = { mtime: stat.mtimeMs, sessionId, todos };
    return todos;
  } catch {
    return [];
  }
}

function readTasks(sessionId: string): TaskItem[] {
  const tasksDir = path.join(getClaudeDir(), 'tasks', sessionId);
  try {
    if (!fs.existsSync(tasksDir)) return [];
    const stat = fs.statSync(tasksDir);
    if (_tasksCache && _tasksCache.sessionId === sessionId && _tasksCache.mtime === stat.mtimeMs) {
      return _tasksCache.tasks;
    }

    const files = fs.readdirSync(tasksDir)
      .filter(f => f.endsWith('.json'));

    const tasks: TaskItem[] = [];
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf-8'));
        if (raw && typeof raw.id === 'string') {
          tasks.push({
            id: raw.id,
            subject: raw.subject ?? raw.id,
            description: raw.description || undefined,
            status: raw.status ?? 'pending',
            blocks: Array.isArray(raw.blocks) ? raw.blocks : [],
            blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy : [],
            activeForm: raw.activeForm || undefined,
          });
        }
      } catch { /* skip corrupt file */ }
    }

    _tasksCache = { mtime: stat.mtimeMs, sessionId, tasks };
    return tasks;
  } catch {
    return [];
  }
}

/**
 * Get tasks and todos for a given session.
 * Results are sorted: in_progress first, then pending, then completed.
 * Cached by directory mtime to avoid re-reading on every poll.
 */
export function getSessionTasks(sessionId: string): SessionTasks {
  if (!sessionId) return EMPTY_TASKS;

  try {
    const todos = readTodos(sessionId);
    const tasks = readTasks(sessionId);

    // Sort tasks: in_progress → pending → completed → deleted
    const statusOrder: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
      deleted: 3,
    };
    tasks.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

    if (todos.length === 0 && tasks.length === 0) return EMPTY_TASKS;

    return { todos, tasks };
  } catch (err) {
    log('error', { function: 'getSessionTasks', message: String(err) });
    return EMPTY_TASKS;
  }
}
