/**
 * Linux hotkey setup: detect GNOME, KDE, i3/sway, fall back to instructions.
 */

import { isCommandAvailable } from './platform.js';
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

export function setupLinux(): SetupResult {
  const desktop = detectDesktop();

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
          '    command "gnome-terminal -- cc --mini"',
          '  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/cldctrl/ \\',
          '    binding "<Control>Up"',
          '',
          'Or: Settings > Keyboard > Custom Shortcuts > Add',
          '  Name: CLD CTRL',
          '  Command: gnome-terminal -- cc --mini',
          '  Shortcut: Ctrl+Up',
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
          '  Action: konsole -e cc --mini',
          '',
          'Or via khotkeys CLI if available.',
        ].join('\n'),
      };

    case 'i3':
      return {
        success: true,
        message: [
          'i3 detected. Add to ~/.config/i3/config:',
          '',
          '  bindsym Ctrl+Up exec --no-startup-id i3-sensible-terminal -e cc --mini',
          '',
          'Then reload: i3-msg reload',
        ].join('\n'),
      };

    case 'sway':
      return {
        success: true,
        message: [
          'Sway detected. Add to ~/.config/sway/config:',
          '',
          '  bindsym Ctrl+Up exec foot cc --mini',
          '',
          'Then reload: swaymsg reload',
        ].join('\n'),
      };

    case 'hyprland':
      return {
        success: true,
        message: [
          'Hyprland detected. Add to ~/.config/hypr/hyprland.conf:',
          '',
          '  bind = CTRL, Up, exec, foot cc --mini',
          '',
          'Config is auto-reloaded.',
        ].join('\n'),
      };

    default:
      return {
        success: true,
        message: [
          'To set up Ctrl+Up on Linux, add a custom shortcut in your desktop environment:',
          '',
          '  Command: <your-terminal> -e cc --mini',
          '  Shortcut: Ctrl+Up',
          '',
          'Common terminals:',
          '  gnome-terminal -- cc --mini',
          '  konsole -e cc --mini',
          '  xterm -e cc --mini',
          '  alacritty -e cc --mini',
          '  kitty cc --mini',
          '  foot cc --mini',
          '',
          'For tiling WMs (i3/sway/hyprland), add a keybind to your config file.',
        ].join('\n'),
      };
  }
}
