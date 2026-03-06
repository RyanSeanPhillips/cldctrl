/**
 * Cross-platform hotkey setup: dispatches to platform-specific implementations.
 * - Windows: VBS wrapper in Startup folder → hotkey.ps1
 * - macOS: skhd / Hammerspoon detection + instructions
 * - Linux: GNOME/KDE/i3 detection + instructions
 */

import { getPlatform } from './platform.js';
import { setupWindows, removeWindows } from './setup-windows.js';
import { setupMacos } from './setup-macos.js';
import { setupLinux } from './setup-linux.js';

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
    case 'macos':
    case 'linux':
      return {
        success: true,
        message: 'Remove the hotkey binding from your system settings manually.',
      };
    default: {
      const _never: never = platform;
      return { success: false, message: `Unsupported platform: ${_never}` };
    }
  }
}
