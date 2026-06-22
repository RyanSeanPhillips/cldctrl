# CLD CTRL Hotkey Listener
# Registers Ctrl+Up as a global hotkey.
# Finds an existing CLD CTRL terminal window and brings it to front,
# or launches a new one if none exists.

$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class CldCtrlHotkey {
    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    public const int HOTKEY_ID = 9001;
    public const uint MOD_CTRL = 0x0002;
    public const uint VK_UP    = 0x26;
}

public class HotkeyWindow : NativeWindow {
    private const int WM_HOTKEY = 0x0312;
    public event EventHandler HotkeyPressed;
    public HotkeyWindow() { CreateHandle(new CreateParams()); }
    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == CldCtrlHotkey.HOTKEY_ID) {
            if (HotkeyPressed != null) HotkeyPressed(this, EventArgs.Empty);
        }
        base.WndProc(ref m);
    }
    public void Destroy() { DestroyHandle(); }
}

// Public, documented Shell interface for querying virtual desktop membership.
[ComImport]
[Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
    [PreserveSig]
    int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
    [PreserveSig]
    int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
    [PreserveSig]
    int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
}

public class WinHelper {
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int nMaxCount);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    private static readonly Guid CLSID_VirtualDesktopManager =
        new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a");

    private static IVirtualDesktopManager GetVdm() {
        try {
            Type t = Type.GetTypeFromCLSID(CLSID_VirtualDesktopManager);
            return (IVirtualDesktopManager)Activator.CreateInstance(t);
        } catch {
            return null; // COM unavailable — caller falls back to any-desktop match
        }
    }

    // Find a window titled `titlePart` ON THE CURRENT virtual desktop. If the
    // virtual desktop API is unavailable, falls back to the first title match
    // anywhere (preserving the original single-instance focus behavior).
    public static IntPtr FindOnCurrentDesktop(string titlePart) {
        IVirtualDesktopManager vdm = GetVdm();
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) < 0)
                return true;

            if (vdm == null) {
                found = hWnd; // no VDM → behave like the old any-desktop find
                return false;
            }
            int onCurrent;
            if (vdm.IsWindowOnCurrentVirtualDesktop(hWnd, out onCurrent) == 0 && onCurrent != 0) {
                found = hWnd;
                return false;
            }
            return true; // title matches but on another desktop — keep looking
        }, IntPtr.Zero);
        return found;
    }

    // Bring window to front: restore if minimized, then set foreground
    public static void BringToFront(IntPtr hwnd) {
        if (IsIconic(hwnd)) {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
    }
}
"@

# ── Config helpers ────────────────────────────────
# Read the cldctrl config so Ctrl+Up can launch either the TUI or the web
# dashboard, per global_hotkey.action. Mirrors getConfigDir() in config.ts:
# CLDCTRL_CONFIG_DIR override → legacy %APPDATA%\claudedock → %APPDATA%\cldctrl.
function Get-CldConfig {
    try {
        $dir = $env:CLDCTRL_CONFIG_DIR
        if (-not $dir) { $dir = $env:CLAUDEDOCK_CONFIG_DIR }
        if (-not $dir) {
            $appdata = $env:APPDATA
            if (-not $appdata) { return $null }
            $legacy = Join-Path $appdata 'claudedock'
            if (Test-Path (Join-Path $legacy 'config.json')) { $dir = $legacy }
            else { $dir = Join-Path $appdata 'cldctrl' }
        }
        $cfgPath = Join-Path $dir 'config.json'
        if (Test-Path $cfgPath) {
            return Get-Content $cfgPath -Raw | ConvertFrom-Json
        }
    } catch { }
    return $null
}

# Is something already listening on the loopback port? (cc serve already up)
function Test-CldPort([int]$port) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(300)
        if ($ok -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        if ($client) { $client.Close() }
    }
}

# Launch (if needed) and surface the web dashboard in the default browser.
function Show-CldWeb([int]$port) {
    if (-not (Test-CldPort $port)) {
        # Start `cc serve` in a hidden cmd window; it stays alive serving requests.
        Start-Process cmd -ArgumentList "/c cc serve --port $port" -WindowStyle Hidden
        for ($i = 0; $i -lt 24; $i++) {
            Start-Sleep -Milliseconds 250
            if (Test-CldPort $port) { break }
        }
    }
    Start-Process "http://localhost:$port"
}

# ── Single-instance guard ─────────────────────────
$mutexName = "Global\CldCtrl_HotkeyListener"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) { exit 0 }

# ── Register Ctrl+Up ──────────────────────────────
$wnd = New-Object HotkeyWindow
$registered = [CldCtrlHotkey]::RegisterHotKey(
    $wnd.Handle, [CldCtrlHotkey]::HOTKEY_ID,
    [CldCtrlHotkey]::MOD_CTRL, [CldCtrlHotkey]::VK_UP
)
if (-not $registered) {
    [System.Windows.Forms.MessageBox]::Show(
        "Failed to register Ctrl+Up hotkey.`nAnother application may be using it.",
        "CLD CTRL", "OK", "Warning") | Out-Null
    $mutex.ReleaseMutex(); exit 1
}

# ── Hotkey handler ────────────────────────────────
$wnd.add_HotkeyPressed({
    $ErrorActionPreference = "Continue"
    try {
        # Decide target from config (default: TUI). Re-read each press so a
        # settings change takes effect without restarting the listener.
        $cfg = Get-CldConfig
        $action = 'tui'
        $port = 2533
        if ($cfg -and $cfg.global_hotkey) {
            if ($cfg.global_hotkey.action) { $action = "$($cfg.global_hotkey.action)" }
            if ($cfg.global_hotkey.web_port) { $port = [int]$cfg.global_hotkey.web_port }
        }

        if ($action -eq 'web') {
            Show-CldWeb $port
            return
        }

        # ── TUI (default) ──
        # Look for an existing CLD CTRL window on the CURRENT virtual desktop
        $hwnd = [WinHelper]::FindOnCurrentDesktop("CLD CTRL")

        if ($hwnd -ne [IntPtr]::Zero) {
            # Found one on this desktop — bring it to front
            [WinHelper]::BringToFront($hwnd)
        } else {
            # None on this desktop — launch a new one (lands on current desktop)
            $useWt = Get-Command wt -ErrorAction SilentlyContinue
            if ($useWt) {
                Start-Process wt -ArgumentList "new-tab --title `"CLD CTRL`" cmd /k cc" -WindowStyle Normal
            } else {
                Start-Process cmd -ArgumentList "/k cc" -WindowStyle Normal
            }
        }
    } catch { }
})

# ── Message loop ──────────────────────────────────
try {
    $appContext = New-Object System.Windows.Forms.ApplicationContext
    [System.Windows.Forms.Application]::Run($appContext)
} finally {
    [CldCtrlHotkey]::UnregisterHotKey($wnd.Handle, [CldCtrlHotkey]::HOTKEY_ID)
    $wnd.Destroy()
    $mutex.ReleaseMutex()
}
