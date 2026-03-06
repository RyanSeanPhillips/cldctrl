# CLD CTRL Hotkey Listener
# Registers Ctrl+Up as a global hotkey to launch the CLD CTRL mini TUI.
# Chromeless popup: no title bar, no borders, closes on focus loss,
# opens on mouse's monitor, remembers position, draggable (hold click).

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

public class PopupHelper {
    // ── Structs ──────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    // ── Constants ────────────────────────────────
    public const int GWL_STYLE       = -16;
    public const int GWL_EXSTYLE     = -20;
    public const int WS_CAPTION      = 0x00C00000;
    public const int WS_THICKFRAME   = 0x00040000;
    public const int WS_SYSMENU      = 0x00080000;
    public const int WS_MINIMIZEBOX  = 0x00020000;
    public const int WS_MAXIMIZEBOX  = 0x00010000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_APPWINDOW  = 0x00040000;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_FRAMECHANGED  = 0x0020;
    public const uint SWP_SHOWWINDOW    = 0x0040;
    public const uint SWP_NOACTIVATE    = 0x0010;
    public const uint SWP_NOZORDER      = 0x0004;
    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;
    public const int VK_LBUTTON = 0x01;
    public const uint WM_SYSCOMMAND = 0x0112;
    public const int SC_MOVE = 0xF010;
    public const uint MONITOR_DEFAULTTONEAREST = 2;
    public const uint MONITOR_DEFAULTTONULL    = 0;

    // ── P/Invoke ─────────────────────────────────
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
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    // ── Find any window (visible or not) by title substring ──
    public static IntPtr FindByTitle(string titlePart) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf(titlePart, StringComparison.Ordinal) >= 0) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // ── Strip title bar, borders, hide from taskbar ──
    public static void StripChrome(IntPtr hwnd) {
        int style = GetWindowLong(hwnd, GWL_STYLE);
        style &= ~WS_CAPTION;
        style &= ~WS_THICKFRAME;
        style &= ~WS_SYSMENU;
        style &= ~WS_MINIMIZEBOX;
        style &= ~WS_MAXIMIZEBOX;
        SetWindowLong(hwnd, GWL_STYLE, style);
        int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        exStyle &= ~WS_EX_APPWINDOW;
        exStyle |= WS_EX_TOOLWINDOW;
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
    }

    // ── Move window off-screen (hide without hiding) ──
    public static void ParkOffScreen(IntPtr hwnd) {
        RECT r; GetWindowRect(hwnd, out r);
        SetWindowPos(hwnd, HWND_TOPMOST, -9999, -9999,
            r.Right - r.Left, r.Bottom - r.Top, SWP_FRAMECHANGED);
    }

    // ── Center on the monitor the mouse cursor is on ──
    public static void CenterOnMouseMonitor(IntPtr hwnd) {
        POINT cursor; GetCursorPos(out cursor);
        IntPtr hMon = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(mi);
        GetMonitorInfo(hMon, ref mi);
        RECT wr; GetWindowRect(hwnd, out wr);
        int w = wr.Right - wr.Left, h = wr.Bottom - wr.Top;
        int x = mi.rcWork.Left + (mi.rcWork.Right - mi.rcWork.Left - w) / 2;
        int y = mi.rcWork.Top  + (mi.rcWork.Bottom - mi.rcWork.Top - h) / 2;
        SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        SetForegroundWindow(hwnd);
    }

    // ── Place at saved position (if still on a valid monitor) ──
    // Returns false if the saved position is off-screen.
    public static bool PlaceAt(IntPtr hwnd, int x, int y) {
        POINT pt; pt.X = x; pt.Y = y;
        IntPtr hMon = MonitorFromPoint(pt, MONITOR_DEFAULTTONULL);
        if (hMon == IntPtr.Zero) return false;  // off-screen
        RECT wr; GetWindowRect(hwnd, out wr);
        int w = wr.Right - wr.Left, h = wr.Bottom - wr.Top;
        SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        SetForegroundWindow(hwnd);
        return true;
    }

    // ── Initiate native window drag via WM_SYSCOMMAND ──
    public static void StartNativeMove(IntPtr hwnd) {
        // SC_MOVE | 2 = mouse-initiated move from caption area
        PostMessage(hwnd, WM_SYSCOMMAND, (IntPtr)(SC_MOVE | 2), IntPtr.Zero);
    }

    public static bool IsLeftButtonDown() {
        return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
    }
}
"@

# ── Pre-compile tiny QuickEdit disabler .exe (one-time) ──
$script:appDir = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("ApplicationData"), "cldctrl")
if (-not [System.IO.Directory]::Exists($script:appDir)) {
    [System.IO.Directory]::CreateDirectory($script:appDir) | Out-Null
}
$script:qeExe = [System.IO.Path]::Combine($script:appDir, "qe-off.exe")
if (-not [System.IO.File]::Exists($script:qeExe)) {
    try {
        $csSrc = [System.IO.Path]::Combine($script:appDir, "qe-off.cs")
        $csCode = 'using System;using System.Runtime.InteropServices;' +
            'class P{[DllImport("kernel32.dll")]static extern IntPtr GetStdHandle(int h);' +
            '[DllImport("kernel32.dll")]static extern bool GetConsoleMode(IntPtr h,out uint m);' +
            '[DllImport("kernel32.dll")]static extern bool SetConsoleMode(IntPtr h,uint m);' +
            'static void Main(){var h=GetStdHandle(-10);uint m;GetConsoleMode(h,out m);SetConsoleMode(h,m&~0x0040u);}}'
        [System.IO.File]::WriteAllText($csSrc, $csCode)
        $csc = [System.IO.Path]::Combine(
            [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory(), "csc.exe")
        if ([System.IO.File]::Exists($csc)) {
            & $csc /nologo /optimize "/out:$($script:qeExe)" "$csSrc" 2>$null | Out-Null
        }
    } catch { }
}

# ── Resolve node.exe + mini-entry.js paths for direct invocation ──
$script:nodeExe = "node"
$script:miniEntryJs = ""
try {
    $ccCmd = Get-Command cc -ErrorAction SilentlyContinue
    if ($ccCmd) {
        $ccDir = [System.IO.Path]::GetDirectoryName($ccCmd.Source)
        # Find the mini-entry.js (dedicated fast entry point)
        $candidate = [System.IO.Path]::Combine($ccDir, "node_modules", "cldctrl", "dist", "mini-entry.js")
        if ([System.IO.File]::Exists($candidate)) {
            $script:miniEntryJs = $candidate
        }
        # Find node.exe
        $nodeCandidate = [System.IO.Path]::Combine($ccDir, "node.exe")
        if ([System.IO.File]::Exists($nodeCandidate)) { $script:nodeExe = $nodeCandidate }
    }
} catch { }

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

# ── Position persistence ──────────────────────────
$script:posFile = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("ApplicationData"), "cldctrl", "popup-pos.json")

function Get-SavedPos {
    try {
        if ([System.IO.File]::Exists($script:posFile)) {
            $j = [System.IO.File]::ReadAllText($script:posFile) | ConvertFrom-Json
            if ($null -ne $j.x -and $null -ne $j.y) { return $j }
        }
    } catch { }
    return $null
}

function Save-PopupPos {
    if ($script:popupHwnd -eq [IntPtr]::Zero) { return }
    try {
        $rect = New-Object PopupHelper+RECT
        [PopupHelper]::GetWindowRect($script:popupHwnd, [ref]$rect) | Out-Null
        $dir = [System.IO.Path]::GetDirectoryName($script:posFile)
        if (-not [System.IO.Directory]::Exists($dir)) {
            [System.IO.Directory]::CreateDirectory($dir) | Out-Null
        }
        $json = "{ ""x"": $($rect.Left), ""y"": $($rect.Top) }"
        [System.IO.File]::WriteAllText($script:posFile, $json)
    } catch { }
}

# ── Popup state ───────────────────────────────────
# Phases: 0=off, 1=finding window, 2=waiting for content, 3=live, 4=hidden (warm)
$script:popupProc   = $null
$script:popupHwnd   = [IntPtr]::Zero
$script:popupPhase  = 0
$script:focusLost   = 0
$script:waitCount   = 0
$script:dragHold    = 0
$script:popupId     = ""
$script:prewarm     = $false   # true = go to Phase 4 (hidden) after ready, not Phase 3

# ── Spawn helper (used at startup for pre-warm and on hotkey) ──
function Start-MiniPopup {
    $script:popupId = "CLDCTRL_" + [guid]::NewGuid().ToString("N").Substring(0, 8)

    # Delete stale ready signal
    $readyPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "cldctrl-ready")
    if ([System.IO.File]::Exists($readyPath)) {
        try { [System.IO.File]::Delete($readyPath) } catch { }
    }

    $env:CLDCTRL_POPUP_ID = $script:popupId
    if ($script:miniEntryJs -ne "") {
        $script:popupProc = Start-Process conhost.exe `
            -ArgumentList "`"$($script:nodeExe)`" `"$($script:miniEntryJs)`"" `
            -WindowStyle Hidden `
            -PassThru
    } else {
        $script:popupProc = Start-Process conhost.exe `
            -ArgumentList "cmd.exe /c `"title $($script:popupId) & mode con cols=48 lines=20 & cc --mini`"" `
            -WindowStyle Hidden `
            -PassThru
    }

    $script:popupPhase = 1
    $script:popupHwnd = [IntPtr]::Zero
    $script:focusLost = 0
    $script:waitCount = 0
    $script:dragHold = 0
    $script:popupTimer.Interval = 10
    $script:popupTimer.Start()
}

# ── Popup timer ───────────────────────────────────
$script:popupTimer = New-Object System.Windows.Forms.Timer
$script:popupTimer.Interval = 10

$script:popupTimer.add_Tick({
    $ErrorActionPreference = "Continue"
    try {
        # Process exited naturally
        if ($null -ne $script:popupProc -and $script:popupProc.HasExited) {
            Save-PopupPos
            $script:popupPhase = 0
            $script:popupTimer.Stop()
            return
        }

        # ── Phase 1: Find window, immediately hide ──
        if ($script:popupPhase -eq 1) {
            $script:waitCount++
            # Timeout: 200 ticks (2s) — give up if window never appears
            if ($script:waitCount -ge 200) {
                try { $script:popupProc.Kill() } catch { }
                $script:popupProc = $null
                $script:popupPhase = 0
                $script:popupTimer.Stop()
                return
            }
            $hwnd = [PopupHelper]::FindByTitle($script:popupId)
            if ($hwnd -ne [IntPtr]::Zero) {
                $script:popupHwnd = $hwnd
                [PopupHelper]::ShowWindow($hwnd, [PopupHelper]::SW_HIDE)
                [PopupHelper]::StripChrome($hwnd)
                [PopupHelper]::ParkOffScreen($hwnd)
                $script:popupPhase = 2
                $script:waitCount = 0
                $script:popupTimer.Interval = 20
            }
        }

        # ── Phase 2: Wait for ready signal (no minimum wait) ──
        elseif ($script:popupPhase -eq 2) {
            $script:waitCount++
            $readyFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "cldctrl-ready")
            $isReady = [System.IO.File]::Exists($readyFile)
            # Show as soon as ready, timeout at 100 ticks (2s)
            if ($isReady -or $script:waitCount -ge 100) {
                if ($script:prewarm) {
                    # Pre-warm: stay hidden, go straight to Phase 4
                    $script:prewarm = $false
                    $script:popupPhase = 4
                    $script:popupTimer.Stop()
                } else {
                    # Normal: show at saved position or centered on mouse's monitor
                    $saved = Get-SavedPos
                    $placed = $false
                    if ($null -ne $saved) {
                        $placed = [PopupHelper]::PlaceAt($script:popupHwnd, [int]$saved.x, [int]$saved.y)
                    }
                    if (-not $placed) {
                        [PopupHelper]::CenterOnMouseMonitor($script:popupHwnd)
                    }
                    [PopupHelper]::ShowWindow($script:popupHwnd, [PopupHelper]::SW_SHOW)
                    [PopupHelper]::SetForegroundWindow($script:popupHwnd)
                    $script:popupPhase = 3
                    $script:popupTimer.Interval = 100
                    $script:focusLost = 0
                    $script:dragHold = 0
                }
            }
        }

        # ── Phase 3: Focus monitoring + drag support ──
        elseif ($script:popupPhase -eq 3) {
            $fg = [PopupHelper]::GetForegroundWindow()
            $isFocused = ($fg -eq $script:popupHwnd)

            # Drag: hold left-click for ~200ms to initiate native window move
            if ($isFocused -and [PopupHelper]::IsLeftButtonDown()) {
                $script:dragHold++
                if ($script:dragHold -ge 2) {
                    [PopupHelper]::StartNativeMove($script:popupHwnd)
                    $script:dragHold = 0
                    $script:focusLost = 0
                    return
                }
            } else {
                $script:dragHold = 0
            }

            # Focus loss → hide after grace period (~300ms), keep process alive
            if (-not $isFocused) {
                $script:focusLost++
                if ($script:focusLost -ge 3) {
                    Save-PopupPos
                    [PopupHelper]::ShowWindow($script:popupHwnd, [PopupHelper]::SW_HIDE)
                    $script:popupPhase = 4
                    $script:popupTimer.Stop()
                }
            } else {
                $script:focusLost = 0
            }
        }

        # ── Phase 4: Hidden (warm) — process alive, window hidden ──
        # Timer is stopped in this phase; hotkey handler re-shows.
        elseif ($script:popupPhase -eq 4) {
            # Shouldn't reach here (timer is stopped), but handle process exit
            if ($null -ne $script:popupProc -and $script:popupProc.HasExited) {
                $script:popupPhase = 0
                $script:popupTimer.Stop()
            }
        }
    } catch {
        $script:popupPhase = 0
        $script:popupTimer.Stop()
    }
})

# ── Hotkey handler ────────────────────────────────
$wnd.add_HotkeyPressed({
    $ErrorActionPreference = "Continue"
    try {
        # Phase 4 (hidden warm process): instant re-show!
        if ($script:popupPhase -eq 4 -and $null -ne $script:popupProc -and -not $script:popupProc.HasExited) {
            # Reposition at saved pos or center, show, focus
            $saved = Get-SavedPos
            $placed = $false
            if ($null -ne $saved) {
                $placed = [PopupHelper]::PlaceAt($script:popupHwnd, [int]$saved.x, [int]$saved.y)
            }
            if (-not $placed) {
                [PopupHelper]::CenterOnMouseMonitor($script:popupHwnd)
            }
            [PopupHelper]::ShowWindow($script:popupHwnd, [PopupHelper]::SW_SHOW)
            [PopupHelper]::SetForegroundWindow($script:popupHwnd)
            $script:popupPhase = 3
            $script:focusLost = 0
            $script:dragHold = 0
            $script:popupTimer.Interval = 100
            $script:popupTimer.Start()
            return
        }

        # Toggle: close visible popup (phases 1-3)
        if ($script:popupPhase -gt 0 -and $null -ne $script:popupProc -and -not $script:popupProc.HasExited) {
            Save-PopupPos
            [PopupHelper]::ShowWindow($script:popupHwnd, [PopupHelper]::SW_HIDE)
            $script:popupPhase = 4
            $script:popupTimer.Stop()
            return
        }

        # Cold start — spawn new popup
        $script:prewarm = $false
        Start-MiniPopup
    } catch { }
})

# ── Pre-warm: spawn popup hidden so first Ctrl+Up is instant ──
$script:prewarm = $true
Start-MiniPopup

# ── Message loop ──────────────────────────────────
try {
    $appContext = New-Object System.Windows.Forms.ApplicationContext
    [System.Windows.Forms.Application]::Run($appContext)
} finally {
    # Clean up child popup on exit
    if ($null -ne $script:popupProc -and -not $script:popupProc.HasExited) {
        try { $script:popupProc.Kill() } catch { }
    }
    [CldCtrlHotkey]::UnregisterHotKey($wnd.Handle, [CldCtrlHotkey]::HOTKEY_ID)
    $wnd.Destroy()
    $mutex.ReleaseMutex()
}
