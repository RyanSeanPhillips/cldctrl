/**
 * Read/write Claude Code's auto-approved tool permissions.
 * Source: ~/.claude/settings.local.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir } from './platform.js';

export interface PermissionsConfig {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface ParsedPermission {
  tool: string;
  scope: string;
}

export function getPermissionsPath(): string {
  return path.join(getHomeDir(), '.claude', 'settings.local.json');
}

/**
 * Load permissions from settings.local.json.
 * Returns empty lists if file doesn't exist or is invalid.
 */
export function loadPermissions(): PermissionsConfig {
  try {
    const p = getPermissionsPath();
    if (!fs.existsSync(p)) return { allow: [], deny: [], ask: [] };
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const perms = raw?.permissions;
    if (!perms || typeof perms !== 'object') return { allow: [], deny: [], ask: [] };
    return {
      allow: Array.isArray(perms.allow) ? perms.allow : [],
      deny: Array.isArray(perms.deny) ? perms.deny : [],
      ask: Array.isArray(perms.ask) ? perms.ask : [],
    };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

/**
 * Save permissions back to settings.local.json.
 * Preserves any other top-level keys in the file.
 * Uses atomic write (tmp + rename).
 */
export function savePermissions(perms: PermissionsConfig): void {
  const p = getPermissionsPath();
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(p)) {
      existing = JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch { /* start fresh */ }

  existing.permissions = {
    allow: perms.allow,
    deny: perms.deny,
    ask: perms.ask,
  };

  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Parse a permission rule string into tool name and scope.
 * Examples:
 *   "Read(/path/**)" → { tool: "Read", scope: "/path/**" }
 *   "Bash(cat:*)"    → { tool: "Bash", scope: "cat:*" }
 *   "WebSearch"      → { tool: "WebSearch", scope: "" }
 */
export function parsePermission(rule: string): ParsedPermission {
  const match = rule.match(/^([^(]+)\((.+)\)$/);
  if (match) {
    return { tool: match[1], scope: match[2] };
  }
  return { tool: rule, scope: '' };
}
