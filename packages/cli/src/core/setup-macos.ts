/**
 * macOS hotkey setup: detect skhd or Hammerspoon, install helper script.
 * The helper script focuses an existing CLD CTRL window or launches a new one.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isCommandAvailable } from './platform.js';
import type { SetupResult } from './setup.js';

/** Focus-or-launch helper script for macOS */
function getHelperScript(): string {
  return `#!/bin/bash
# CLD CTRL hotkey helper: focus existing window or launch new one
# Checks Terminal.app and iTerm2 for a window titled "CLD CTRL"

focus_terminal() {
  osascript -e '
    tell application "Terminal"
      if it is running then
        repeat with w in windows
          if name of w contains "CLD CTRL" then
            set frontmost of w to true
            activate
            return "found"
          end if
        end repeat
      end if
    end tell
    return "not found"
  ' 2>/dev/null
}

focus_iterm() {
  osascript -e '
    tell application "iTerm2"
      if it is running then
        repeat with w in windows
          if name of w contains "CLD CTRL" then
            select w
            activate
            return "found"
          end if
        end repeat
      end if
    end tell
    return "not found"
  ' 2>/dev/null
}

# Try to focus existing window in common terminal apps
result=$(focus_terminal)
if [ "$result" = "found" ]; then exit 0; fi

result=$(focus_iterm)
if [ "$result" = "found" ]; then exit 0; fi

# No existing window — launch new one
if command -v cc >/dev/null 2>&1; then
  if [ -n "$TERM_PROGRAM" ] && [ "$TERM_PROGRAM" = "iTerm.app" ]; then
    osascript -e 'tell application "iTerm2" to create window with default profile command "cc"' 2>/dev/null
  else
    osascript -e 'tell application "Terminal" to do script "cc"' 2>/dev/null
    osascript -e 'tell application "Terminal" to activate' 2>/dev/null
  fi
fi
`;
}

function getHelperPath(): string {
  const configDir = path.join(os.homedir(), '.config', 'cldctrl');
  return path.join(configDir, 'hotkey.sh');
}

function installHelper(): string {
  const helperPath = getHelperPath();
  const dir = path.dirname(helperPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(helperPath, getHelperScript(), { mode: 0o755 });
  return helperPath;
}

export function setupMacos(): SetupResult {
  const helperPath = installHelper();

  // Try skhd (popular tiling WM hotkey daemon)
  if (isCommandAvailable('skhd')) {
    const skhdrc = path.join(os.homedir(), '.skhdrc');
    const binding = `ctrl - up : ${helperPath}`;

    // Check if already configured
    if (fs.existsSync(skhdrc)) {
      const content = fs.readFileSync(skhdrc, 'utf-8');
      if (content.includes('cldctrl') || content.includes('CLD CTRL')) {
        return {
          success: true,
          message: `skhd already has a CLD CTRL binding in ~/.skhdrc\n\nHelper script updated: ${helperPath}`,
        };
      }
    }

    return {
      success: true,
      message: [
        'skhd detected. Add this to ~/.skhdrc:',
        '',
        `  ${binding}`,
        '',
        'Then reload: skhd --reload',
        '',
        `Helper script installed: ${helperPath}`,
        'Press Ctrl+Up to focus CLD CTRL or launch a new instance.',
      ].join('\n'),
    };
  }

  // Try Hammerspoon
  const hsInit = path.join(os.homedir(), '.hammerspoon', 'init.lua');
  if (fs.existsSync(hsInit) || isCommandAvailable('hs')) {
    return {
      success: true,
      message: [
        'Hammerspoon detected. Add this to ~/.hammerspoon/init.lua:',
        '',
        '  hs.hotkey.bind({"ctrl"}, "up", function()',
        `    hs.execute("${helperPath}")`,
        '  end)',
        '',
        'Then reload: Hammerspoon > Reload Config',
        '',
        `Helper script installed: ${helperPath}`,
      ].join('\n'),
    };
  }

  // Fallback: general instructions
  return {
    success: true,
    message: [
      'To set up Ctrl+Up on macOS, choose one of:',
      '',
      '1. Install skhd (brew install koekeishiya/formulae/skhd)',
      `   Add to ~/.skhdrc:  ctrl - up : ${helperPath}`,
      '',
      '2. Install Hammerspoon (brew install --cask hammerspoon)',
      '   Bind Ctrl+Up to run the helper script.',
      '',
      '3. Use BetterTouchTool, Karabiner-Elements, or Raycast:',
      `   Bind Ctrl+Up to run: ${helperPath}`,
      '',
      `Helper script installed: ${helperPath}`,
      'It will focus an existing CLD CTRL window or launch a new one.',
    ].join('\n'),
  };
}

export function removeMacos(): SetupResult {
  const helperPath = getHelperPath();
  try { fs.unlinkSync(helperPath); } catch { /* ignore */ }
  return {
    success: true,
    message: [
      'Helper script removed.',
      'Remove the hotkey binding from your keybind tool (skhd, Hammerspoon, etc.) manually.',
    ].join('\n'),
  };
}
