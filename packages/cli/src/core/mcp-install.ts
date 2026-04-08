/**
 * MCP server registration: installs/removes cldctrl MCP config
 * in Claude Code's settings so it auto-discovers the server.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

interface McpResult {
  success: boolean;
  message: string;
  configPath: string;
}

/**
 * Get the path to Claude Code's MCP settings file.
 * Claude Code reads MCP servers from ~/.claude.json under the "mcpServers" key.
 */
function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Resolve the MCP server command and args.
 * Uses node + absolute path to the bin script so it works regardless of
 * whether cldctrl is installed globally, locally, or run from source.
 */
function resolveMcpServerEntry(): { command: string; args: string[] } {
  // Find the bin script relative to this module's location
  // In built form: dist/mcp-install-XXXX.js → bin/cldctrl-mcp.js
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(thisDir, '..', 'bin', 'cldctrl-mcp.js');
  if (fs.existsSync(scriptPath)) {
    return { command: 'node', args: [scriptPath] };
  }

  // Fallback: try to find via the global npm bin
  // This handles the case where the package is installed globally
  return { command: 'cldctrl-mcp', args: [] };
}

/**
 * Register the cldctrl MCP server with Claude Code.
 * Merges into existing config without overwriting other MCP servers.
 */
export function installMcpServer(): McpResult {
  const configPath = getClaudeConfigPath();

  try {
    // Read existing config (may not exist yet)
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw);
    }

    // Merge mcpServers — preserve existing servers
    const mcpServers = (config.mcpServers as Record<string, unknown>) || {};
    const entry = resolveMcpServerEntry();
    mcpServers.cldctrl = {
      command: entry.command,
      args: entry.args,
    };
    config.mcpServers = mcpServers;

    // Atomic write
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmpPath, configPath);

    log('info', { function: 'installMcpServer', configPath });
    return {
      success: true,
      message: `MCP server registered in ${configPath}\nClaude Code will discover the cldctrl tools in new conversations.`,
      configPath,
    };
  } catch (err) {
    log('error', { function: 'installMcpServer', message: String(err) });
    return {
      success: false,
      message: `Failed to register MCP server: ${err}`,
      configPath,
    };
  }
}

/**
 * Remove the cldctrl MCP server registration from Claude Code.
 */
export function uninstallMcpServer(): McpResult {
  const configPath = getClaudeConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      return { success: true, message: 'No Claude config found — nothing to remove.', configPath };
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const mcpServers = config.mcpServers;
    if (!mcpServers || !mcpServers.cldctrl) {
      return { success: true, message: 'cldctrl MCP server not registered — nothing to remove.', configPath };
    }

    delete mcpServers.cldctrl;
    config.mcpServers = mcpServers;

    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmpPath, configPath);

    log('info', { function: 'uninstallMcpServer', configPath });
    return {
      success: true,
      message: `cldctrl MCP server removed from ${configPath}`,
      configPath,
    };
  } catch (err) {
    log('error', { function: 'uninstallMcpServer', message: String(err) });
    return {
      success: false,
      message: `Failed to remove MCP server: ${err}`,
      configPath,
    };
  }
}
