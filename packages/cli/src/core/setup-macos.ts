/**
 * macOS hotkey setup: detect skhd or Hammerspoon, fall back to instructions.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isCommandAvailable } from './platform.js';
import type { SetupResult } from './setup.js';

export function setupMacos(): SetupResult {
  // Try skhd (popular tiling WM hotkey daemon)
  if (isCommandAvailable('skhd')) {
    const skhdrc = path.join(os.homedir(), '.skhdrc');
    const binding = 'ctrl - up : open -a Terminal cc --mini';

    // Check if already configured
    if (fs.existsSync(skhdrc)) {
      const content = fs.readFileSync(skhdrc, 'utf-8');
      if (content.includes('cc --mini') || content.includes('cc -m')) {
        return {
          success: true,
          message: 'skhd already has a CLD CTRL binding in ~/.skhdrc',
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
        'Or to open in a new Terminal.app tab:',
        '  ctrl - up : osascript -e \'tell application "Terminal" to do script "cc --mini"\'',
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
        '    hs.execute("open -a Terminal")',
        '    hs.timer.doAfter(0.3, function()',
        '      hs.execute("osascript -e \'tell application \\"Terminal\\" to do script \\"cc --mini\\"\'")',
        '    end)',
        '  end)',
        '',
        'Then reload: Hammerspoon > Reload Config',
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
      '   Add to ~/.skhdrc:  ctrl - up : open -a Terminal cc --mini',
      '',
      '2. Install Hammerspoon (brew install --cask hammerspoon)',
      '   See: https://www.hammerspoon.org/',
      '',
      '3. Use Automator + System Preferences:',
      '   Create a Quick Action that runs: cc --mini',
      '   Assign a keyboard shortcut in System Preferences > Keyboard > Shortcuts',
      '',
      '4. Use BetterTouchTool, Karabiner-Elements, or similar.',
    ].join('\n'),
  };
}
