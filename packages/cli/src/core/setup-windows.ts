/**
 * Windows hotkey setup: VBS wrapper in Startup folder → hotkey.ps1.
 * Extracted from the original setup.ts for cross-platform dispatch.
 */

import fs from 'node:fs';
import path from 'node:path';
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
    `WshShell.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${hotkeyScript}""", 0, False`,
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
