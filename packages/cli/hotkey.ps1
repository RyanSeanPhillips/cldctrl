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

    // Find a window by title substring (checks all windows including minimized)
    public static IntPtr FindByTitle(string titlePart) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hWnd;
                return false;
            }
            return true;
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
        # Look for an existing CLD CTRL window
        $hwnd = [WinHelper]::FindByTitle("CLD CTRL")

        if ($hwnd -ne [IntPtr]::Zero) {
            # Found it — bring to front
            [WinHelper]::BringToFront($hwnd)
        } else {
            # No existing window — launch a new one
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
