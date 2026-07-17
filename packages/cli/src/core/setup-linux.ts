/**
 * Linux hotkey setup: detect GNOME, KDE, i3/sway/Hyprland, install helper script.
 * The helper script focuses an existing CLD CTRL window or launches a new one.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { isCommandAvailable, detectLinuxTerminal, linuxTerminalArgs } from './platform.js';
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
${[terminal, ...linuxTerminalArgs(terminal, ['cc'])].join(' ')}
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

// ── App-mode desktop launcher (freedesktop .desktop) ─────────────
// The Linux equivalent of `cc shortcut`: a .desktop entry in the app menu that
// opens the dashboard as a chromeless app window (`cc web --app`). --pin adds it
// to the GNOME dash favorites. Mirrors installAppShortcut() on Windows.

const DESKTOP_ID = 'cldctrl';
const DESKTOP_FILE = DESKTOP_ID + '.desktop';

/** Find the bundled 512px PNG icon (package root/assets, shipped via package.json files). */
function getLinuxIconAsset(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url)); // decodes %20 etc. — safe for paths with spaces
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'assets', 'icon-512.png');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/** Absolute, PATH-independent command that a GUI launcher can run to open app mode.
 *  Prefer the exact node + bin script we're running under (a desktop session's PATH
 *  may not include the npm global bin); fall back to bare `cc` if we can't resolve. */
function resolveAppExec(): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  const script = process.argv[1];
  if (script && /cldctrl(\.js)?$/.test(script) && fs.existsSync(script)) {
    return `${q(process.execPath)} ${q(script)} web --app`;
  }
  return 'cc web --app';
}

function applicationsDir(): string { return path.join(os.homedir(), '.local', 'share', 'applications'); }
function iconsDir(): string { return path.join(os.homedir(), '.local', 'share', 'icons'); }

export function installAppShortcutLinux(opts: { pin?: boolean } = {}): SetupResult {
  const appDir = applicationsDir();
  try { fs.mkdirSync(appDir, { recursive: true }); } catch { /* ignore */ }

  // Copy the icon into the user icon dir so the entry survives the package moving.
  let iconRef = DESKTOP_ID; // themed-icon name fallback
  const asset = getLinuxIconAsset();
  if (asset) {
    try {
      fs.mkdirSync(iconsDir(), { recursive: true });
      const dest = path.join(iconsDir(), DESKTOP_ID + '.png');
      fs.copyFileSync(asset, dest);
      iconRef = dest; // absolute path — most robust across DEs
    } catch { iconRef = asset; }
  }

  const desktopPath = path.join(appDir, DESKTOP_FILE);
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=CLD CTRL',
    'Comment=Mission control for Claude Code',
    `Exec=${resolveAppExec()}`,
    `Icon=${iconRef}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    'StartupNotify=true',
    // Groups the Chrome --app window (launched with --class=cldctrl) under this icon.
    'StartupWMClass=cldctrl',
    '',
  ].join('\n');

  try {
    fs.writeFileSync(desktopPath, entry, { mode: 0o755 });
  } catch (e) {
    return { success: false, message: `Could not write ${desktopPath}: ${String(e)}` };
  }

  // Best-effort: refresh the app menu so the entry shows up without a re-login.
  if (isCommandAvailable('update-desktop-database')) {
    try { spawn.sync('update-desktop-database', [appDir], { stdio: 'ignore', timeout: 8000 }); } catch { /* ignore */ }
  }

  const lines = [`Installed app launcher → ${desktopPath}`, 'Find "CLD CTRL" in your applications menu; it opens the dashboard as an app window.'];

  if (opts.pin) lines.push('', pinToDashLinux().message);
  else lines.push('', 'Tip: run `cc shortcut --pin` to add it to your dock/favorites (GNOME).');

  return { success: true, message: lines.join('\n') };
}

/**
 * Idempotently ensure the app-mode `.desktop` entry + icon exist so a Chrome
 * `--app` window launched with `--class=cldctrl` groups under our icon instead
 * of a generic Chromium/orphan entry. Called on every Linux app-mode launch;
 * fast no-op once installed. Best-effort — a missing icon must never block the
 * window from opening, so all failures are swallowed.
 */
export function ensureAppShortcutLinux(): void {
  try {
    const desktopPath = path.join(applicationsDir(), DESKTOP_FILE);
    if (fs.existsSync(desktopPath)) return; // already installed — cheap path
    installAppShortcutLinux(); // writes .desktop + copies icon; no pin, silent
  } catch { /* best-effort */ }
}

/** Add the entry to GNOME dash favorites (idempotent). Other DEs: manual pin. */
function pinToDashLinux(): SetupResult {
  const desktop = detectDesktop();
  if (desktop !== 'gnome' || !isCommandAvailable('gsettings')) {
    return { success: true, message: 'To pin: right-click "CLD CTRL" in your app menu → Add to Favorites / Pin to dock.' };
  }
  try {
    const cur = spawn.sync('gsettings', ['get', 'org.gnome.shell', 'favorite-apps'], { encoding: 'utf-8', timeout: 8000 });
    const raw = (cur.stdout ?? '').trim(); // e.g. ['org.gnome.Nautilus.desktop', ...]
    if (raw.includes(`'${DESKTOP_FILE}'`)) return { success: true, message: 'Already pinned to the GNOME dash.' };
    const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
    const next = inner ? `[${inner}, '${DESKTOP_FILE}']` : `['${DESKTOP_FILE}']`;
    const set = spawn.sync('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', next], { stdio: 'ignore', timeout: 8000 });
    if (set.status === 0) return { success: true, message: 'Pinned CLD CTRL to the GNOME dash.' };
    return { success: true, message: 'Could not pin automatically — pin it from the app menu.' };
  } catch {
    return { success: true, message: 'Could not pin automatically — pin it from the app menu.' };
  }
}

export function removeAppShortcutLinux(): SetupResult {
  const desktopPath = path.join(applicationsDir(), DESKTOP_FILE);
  try { fs.unlinkSync(desktopPath); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(iconsDir(), DESKTOP_ID + '.png')); } catch { /* ignore */ }
  // Best-effort unpin from GNOME favorites.
  if (isCommandAvailable('gsettings')) {
    try {
      const cur = spawn.sync('gsettings', ['get', 'org.gnome.shell', 'favorite-apps'], { encoding: 'utf-8', timeout: 8000 });
      const raw = (cur.stdout ?? '').trim();
      if (raw.includes(`'${DESKTOP_FILE}'`)) {
        const next = raw.replace(new RegExp(`\\s*,?\\s*'${DESKTOP_FILE}'`), '').replace(`['${DESKTOP_FILE}', `, '[').replace(`['${DESKTOP_FILE}']`, '[]');
        spawn.sync('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', next], { stdio: 'ignore', timeout: 8000 });
      }
    } catch { /* ignore */ }
  }
  return { success: true, message: 'Removed the CLD CTRL app launcher.' };
}
