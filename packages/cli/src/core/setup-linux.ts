/**
 * Linux hotkey setup: detect GNOME, KDE, i3/sway/Hyprland, install helper script.
 * The helper script focuses an existing CLD CTRL window or launches a new one.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isCommandAvailable, detectLinuxTerminal } from './platform.js';
import type { SetupResult } from './setup.js';

function detectDesktop(): string | null {
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  if (desktop.includes('gnome')) return 'gnome';
  if (desktop.includes('kde') || desktop.includes('plasma')) return 'kde';
  if (desktop.includes('i3')) return 'i3';
  if (desktop.includes('sway')) return 'sway';
  if (desktop.includes('hyprland')) return 'hyprland';
  return null;
}

/** Focus-or-launch helper script for Linux */
function getHelperScript(): string {
  const terminal = detectLinuxTerminal() ?? 'x-terminal-emulator';
  return `#!/bin/bash
# CLD CTRL hotkey helper: focus existing window or launch new one

# Try wmctrl (X11, most desktop environments)
if command -v wmctrl >/dev/null 2>&1; then
  wmctrl -a "CLD CTRL" 2>/dev/null && exit 0
fi

# Try xdotool (X11 fallback)
if command -v xdotool >/dev/null 2>&1; then
  WID=$(xdotool search --name "CLD CTRL" 2>/dev/null | head -1)
  if [ -n "$WID" ]; then
    xdotool windowactivate "$WID" 2>/dev/null && exit 0
  fi
fi

# Wayland: try swaymsg (Sway)
if [ -n "$SWAYSOCK" ] && command -v swaymsg >/dev/null 2>&1; then
  swaymsg '[title="CLD CTRL"] focus' 2>/dev/null && exit 0
fi

# Wayland: try hyprctl (Hyprland)
if [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ] && command -v hyprctl >/dev/null 2>&1; then
  hyprctl dispatch focuswindow "title:CLD CTRL" 2>/dev/null && exit 0
fi

# No existing window found — launch new one
${terminal} ${terminal === 'gnome-terminal' ? '-- cc' : terminal === 'kitty' ? 'cc' : '-e cc'}
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

export function setupLinux(): SetupResult {
  const desktop = detectDesktop();
  const helperPath = installHelper();

  switch (desktop) {
    case 'gnome':
      return {
        success: true,
        message: [
          'GNOME detected. Set up with gsettings:',
          '',
          '  # Create a custom shortcut',
          '  gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings \\',
          '    "[\'/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cldctrl/\']"',
          '  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cldctrl/ \\',
          '    name "CLD CTRL"',
          '  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cldctrl/ \\',
          `    command "${helperPath}"`,
          '  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cldctrl/ \\',
          '    binding "<Control>Up"',
          '',
          'Or: Settings > Keyboard > Custom Shortcuts > Add',
          '  Name: CLD CTRL',
          `  Command: ${helperPath}`,
          '  Shortcut: Ctrl+Up',
          '',
          `Helper script installed: ${helperPath}`,
        ].join('\n'),
      };

    case 'kde':
      return {
        success: true,
        message: [
          'KDE Plasma detected. Set up via System Settings:',
          '',
          '  System Settings > Shortcuts > Custom Shortcuts > Edit > New > Global Shortcut > Command/URL',
          '  Trigger: Ctrl+Up',
          `  Action: ${helperPath}`,
          '',
          `Helper script installed: ${helperPath}`,
        ].join('\n'),
      };

    case 'i3':
      return {
        success: true,
        message: [
          'i3 detected. Add to ~/.config/i3/config:',
          '',
          `  bindsym Ctrl+Up exec --no-startup-id ${helperPath}`,
          '',
          'Then reload: i3-msg reload',
          '',
          `Helper script installed: ${helperPath}`,
        ].join('\n'),
      };

    case 'sway':
      return {
        success: true,
        message: [
          'Sway detected. Add to ~/.config/sway/config:',
          '',
          `  bindsym Ctrl+Up exec ${helperPath}`,
          '',
          'Then reload: swaymsg reload',
          '',
          `Helper script installed: ${helperPath}`,
        ].join('\n'),
      };

    case 'hyprland':
      return {
        success: true,
        message: [
          'Hyprland detected. Add to ~/.config/hypr/hyprland.conf:',
          '',
          `  bind = CTRL, Up, exec, ${helperPath}`,
          '',
          'Config is auto-reloaded.',
          '',
          `Helper script installed: ${helperPath}`,
        ].join('\n'),
      };

    default:
      return {
        success: true,
        message: [
          'To set up Ctrl+Up on Linux, add a custom shortcut in your desktop environment:',
          '',
          `  Command: ${helperPath}`,
          '  Shortcut: Ctrl+Up',
          '',
          'For X11 window focus, install wmctrl:',
          '  sudo apt install wmctrl  # Debian/Ubuntu',
          '  sudo dnf install wmctrl  # Fedora',
          '',
          `Helper script installed: ${helperPath}`,
          'It will focus an existing CLD CTRL window or launch a new one.',
        ].join('\n'),
      };
  }
}

export function removeLinux(): SetupResult {
  const helperPath = getHelperPath();
  try { fs.unlinkSync(helperPath); } catch { /* ignore */ }
  return {
    success: true,
    message: [
      'Helper script removed.',
      'Remove the keyboard shortcut from your desktop settings manually.',
    ].join('\n'),
  };
}
