/**
 * Windows hotkey setup: VBS wrapper in Startup folder → hotkey.ps1.
 * Extracted from the original setup.ts for cross-platform dispatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SetupResult } from './setup.js';

const STARTUP_FILENAME = 'CldCtrl-Hotkey.vbs';

function getStartupDir(): string {
  const appdata = process.env.APPDATA;
  if (!appdata) throw new Error('APPDATA not set');
  return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
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
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${hotkeyScript}""", 0, False`,
  ].join('\r\n');

  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');

  // Launch now so the user doesn't have to reboot
  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  spawn.spawn('powershell', [
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', hotkeyScript,
  ], { detached: true, stdio: 'ignore' }).unref();

  return {
    success: true,
    message: [
      'Ctrl+Up hotkey installed successfully.',
      '',
      `  Startup: ${vbsPath}`,
      `  Script:  ${hotkeyScript}`,
      '',
      'The hotkey listener is now running. Press Ctrl+Up to launch CLD CTRL.',
      'It will start automatically on login.',
      '',
      'To remove: cldctrl setup --uninstall',
    ].join('\n'),
  };
}

export function removeWindows(): SetupResult {
  const startupDir = getStartupDir();
  const vbsPath = path.join(startupDir, STARTUP_FILENAME);

  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
  }

  const spawn = require('cross-spawn') as typeof import('cross-spawn');
  try {
    spawn.sync('powershell', [
      '-Command',
      'Get-Process powershell | Where-Object { $_.CommandLine -like "*hotkey.ps1*" } | Stop-Process -Force -ErrorAction SilentlyContinue',
    ], { stdio: 'ignore' });
  } catch { /* ignore */ }

  return {
    success: true,
    message: 'Ctrl+Up hotkey removed from startup and stopped.',
  };
}
