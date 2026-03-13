/**
 * Cross-platform hotkey setup: dispatches to platform-specific implementations.
 * - Windows: VBS wrapper in Startup folder + Scheduled Task → hotkey.ps1
 * - macOS: helper script + skhd/Hammerspoon instructions
 * - Linux: helper script + desktop environment instructions
 */

import { getPlatform } from './platform.js';
import { setupWindows, removeWindows } from './setup-windows.js';
import { setupMacos, removeMacos } from './setup-macos.js';
import { setupLinux, removeLinux } from './setup-linux.js';

export interface SetupResult {
  success: boolean;
  message: string;
}

export function setupHotkey(): SetupResult {
  const platform = getPlatform();
  switch (platform) {
    case 'windows': return setupWindows();
    case 'macos': return setupMacos();
    case 'linux': return setupLinux();
    default: {
      const _never: never = platform;
      return { success: false, message: `Unsupported platform: ${_never}` };
    }
  }
}

export function removeHotkey(): SetupResult {
  const platform = getPlatform();
  switch (platform) {
    case 'windows': return removeWindows();
    case 'macos': return removeMacos();
    case 'linux': return removeLinux();
    default: {
      const _never: never = platform;
      return { success: false, message: `Unsupported platform: ${_never}` };
    }
  }
}
