/**
 * Windows hotkey setup: VBS wrapper in Startup folder → hotkey.ps1.
 * Extracted from the original setup.ts for cross-platform dispatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigDir } from '../config.js';
import type { SetupResult } from './setup.js';

const STARTUP_FILENAME = 'CldCtrl-Hotkey.vbs';
const TASK_NAME = 'CldCtrl-Hotkey';

function getStartupDir(): string {
  const appdata = process.env.APPDATA;
  if (!appdata) throw new Error('APPDATA not set');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/**
 * Try to register a Scheduled Task with AtLogon trigger.
 * These run earlier than Startup folder items and bypass Windows 11 startup throttling.
 * Returns true if successful (may fail without admin rights).
 */
function tryRegisterScheduledTask(hotkeyScript: string): boolean {
  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  try {
    const psCommand = [
      `$action = New-ScheduledTaskAction -Execute 'powershell' -Argument '-NonInteractive -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${hotkeyScript}"'`,
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
      `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    ].join('; ');
    const result = spawn.sync('powershell', ['-Command', psCommand], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function tryRemoveScheduledTask(): void {
  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  try {
    spawn.sync('powershell', [
      '-Command',
      `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ], { stdio: 'ignore' });
  } catch { /* ignore */ }
}

function getHotkeyScriptPath(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'hotkey.ps1');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(dir, 'hotkey.ps1');
}

export function setupWindows(): SetupResult {
  const hotkeyScript = getHotkeyScriptPath();
  if (!fs.existsSync(hotkeyScript)) {
    return {
      success: false,
      message: `Hotkey script not found at ${hotkeyScript}. Reinstall the package.`,
    };
  }

  const startupDir = getStartupDir();
  if (!fs.existsSync(startupDir)) {
    return { success: false, message: `Startup folder not found: ${startupDir}` };
  }

  const vbsPath = path.join(startupDir, STARTUP_FILENAME);
  const vbsContent = [
    '\'Brief delay for system startup (PATH resolution)',
    'WScript.Sleep 2000',
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${hotkeyScript}""", 0, False`,
  ].join('\r\n');

  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');

  // Try to also register a Scheduled Task (faster startup, bypasses throttling)
  const hasTask = tryRegisterScheduledTask(hotkeyScript);

  // Launch now so the user doesn't have to reboot
  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  spawn.spawn('powershell', [
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', hotkeyScript,
  ], { detached: true, stdio: 'ignore' }).unref();

  const lines = [
    'Ctrl+Up hotkey installed successfully.',
    '',
    `  Startup: ${vbsPath}`,
    `  Script:  ${hotkeyScript}`,
  ];
  if (hasTask) {
    lines.push(`  Task:    ${TASK_NAME} (scheduled task for faster boot startup)`);
  }
  lines.push(
    '',
    'The hotkey listener is now running. Press Ctrl+Up to launch CLD CTRL.',
    'It will start automatically on login.',
    '',
    'To remove: cldctrl setup --uninstall',
  );

  return { success: true, message: lines.join('\n') };
}

export function removeWindows(): SetupResult {
  const startupDir = getStartupDir();
  const vbsPath = path.join(startupDir, STARTUP_FILENAME);

  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
  }

  tryRemoveScheduledTask();

  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  try {
    spawn.sync('powershell', [
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' AND CommandLine LIKE '%hotkey.ps1%'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } catch { /* ignore */ }

  return {
    success: true,
    message: 'Ctrl+Up hotkey removed from startup and stopped.',
  };
}

// ── App-mode launcher shortcut ───────────────────────────────

const SHORTCUT_NAME = 'CLD CTRL.lnk';
const APP_VBS_NAME = 'cldctrl-app.vbs';

/** Find the bundled cldctrl.ico (package root, shipped via package.json files). */
function getIconPath(): string | null {
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'cldctrl.ico');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Create a Start Menu (+ optional Desktop) shortcut that launches the dashboard
 * as a chromeless app-mode window (`cc web --app`) via a hidden VBS wrapper so
 * no console flashes. Requires cldctrl installed globally (`cc` on PATH).
 */
export function installAppShortcut(opts: { desktop?: boolean } = {}): SetupResult {
  const appdata = process.env.APPDATA;
  if (!appdata) return { success: false, message: 'APPDATA not set' };
  const configDir = getConfigDir();
  try { fs.mkdirSync(configDir, { recursive: true }); } catch { /* ignore */ }
  // Hidden launcher: start app mode with no console window (0 = hidden).
  const vbsPath = path.join(configDir, APP_VBS_NAME);
  try {
    fs.writeFileSync(vbsPath, 'Set s = CreateObject("WScript.Shell")\r\ns.Run "cmd /c cc web --app", 0, False\r\n', 'utf-8');
  } catch (err) {
    return { success: false, message: `Could not write launcher: ${err}` };
  }

  const startMenu = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const targets = [path.join(startMenu, SHORTCUT_NAME)];
  if (opts.desktop) targets.push(path.join(os.homedir(), 'Desktop', SHORTCUT_NAME));

  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  const psq = (s: string) => s.replace(/'/g, "''"); // PowerShell single-quote escape
  const icon = getIconPath();
  let made = 0;
  for (const lnk of targets) {
    const ps = [
      `$w = New-Object -ComObject WScript.Shell`,
      `$s = $w.CreateShortcut('${psq(lnk)}')`,
      `$s.TargetPath = 'wscript.exe'`,
      `$s.Arguments = '"${psq(vbsPath)}"'`,
      `$s.Description = 'CLD CTRL dashboard (app mode)'`,
      `$s.WorkingDirectory = '${psq(configDir)}'`,
      ...(icon ? [`$s.IconLocation = '${psq(icon)},0'`] : []),
      `$s.Save()`,
    ].join('; ');
    try {
      const r = spawn.sync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
      if (r.status === 0) made++;
    } catch { /* ignore */ }
  }
  if (!made) return { success: false, message: 'Failed to create shortcut(s).' };
  return { success: true, message: `Created ${made} CLD CTRL app shortcut${made === 1 ? '' : 's'} → launches "cc web --app".` };
}

export function removeAppShortcut(): SetupResult {
  const appdata = process.env.APPDATA;
  const targets = [
    appdata ? path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', SHORTCUT_NAME) : '',
    path.join(os.homedir(), 'Desktop', SHORTCUT_NAME),
    path.join(getConfigDir(), APP_VBS_NAME),
  ].filter(Boolean);
  for (const p of targets) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } }
  return { success: true, message: 'Removed CLD CTRL app shortcut(s).' };
}

/**
 * Best-effort "pin to taskbar" for quick launch like Chrome. Windows 10/11
 * deliberately restrict programmatic taskbar pinning for third-party apps: the
 * "Pin to taskbar" shell verb was hidden in Win10 1809+ and is usually absent on
 * Win11. We ensure the shortcut exists, then try the verb (resolved from
 * shell32.dll,-5386 so it works in any UI language). If the verb is gone we
 * return success:false with guidance to right-click → Pin to taskbar (one click).
 */
export function pinAppToTaskbar(): SetupResult {
  const appdata = process.env.APPDATA;
  if (!appdata) return { success: false, message: 'APPDATA not set' };
  // Make sure the Start-Menu shortcut exists to pin.
  const install = installAppShortcut({ desktop: false });
  if (!install.success) return install;
  const lnk = path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', SHORTCUT_NAME);
  const psq = (s: string) => s.replace(/'/g, "''");
  // Resolve the localized verb name, then invoke the matching verb on the .lnk.
  const ps = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$def='[DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern int SHLoadIndirectString(string s,System.Text.StringBuilder o,int c,System.IntPtr r);'`,
    `$t=Add-Type -MemberDefinition $def -Name Pin -Namespace W32 -PassThru`,
    `$sb=New-Object System.Text.StringBuilder 1024`,
    `[void]$t::SHLoadIndirectString('@shell32.dll,-5386',$sb,$sb.Capacity,[System.IntPtr]::Zero)`,
    `$pin=$sb.ToString()`,
    `$sh=New-Object -ComObject Shell.Application`,
    `$dir=Split-Path '${psq(lnk)}'`,
    `$leaf=Split-Path '${psq(lnk)}' -Leaf`,
    `$item=$sh.Namespace($dir).ParseName($leaf)`,
    `$done=$false`,
    `foreach($v in $item.Verbs()){ $n=$v.Name -replace '&','' ; if(($pin -and $n -eq $pin) -or $n -match 'taskbar'){ $v.DoIt(); $done=$true; break } }`,
    `if($done){ Write-Output 'PINNED' } else { Write-Output 'NOVERB' }`,
  ].join('; ');
  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  try {
    const r = spawn.sync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf-8' });
    if (r.status === 0 && String(r.stdout).includes('PINNED')) {
      return { success: true, message: 'Pinned CLD CTRL to the taskbar.' };
    }
  } catch { /* fall through */ }
  return {
    success: false,
    message: 'Windows blocks auto-pinning on this version. Right-click the CLD CTRL Start-Menu tile → "Pin to taskbar".',
  };
}
