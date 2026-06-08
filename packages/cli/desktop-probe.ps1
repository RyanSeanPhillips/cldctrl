# CLD CTRL Virtual Desktop Probe
# Prints "BLOCKED" if a window titled "CLD CTRL" exists on the CURRENT virtual
# desktop, excluding the foreground window (the terminal the user just launched
# from). Otherwise prints "OK".
#
# Used by the typed-`cc` single-instance guard to allow one instance per virtual
# desktop: a launching process treats "another CLD CTRL window already on this
# desktop" as contention, but ignores its own window and windows on other desktops.
#
# Detection is window-title based ("CLD CTRL") — the same anchor hotkey.ps1 uses —
# which works under Windows Terminal/ConPTY where the Node console is a hidden
# pseudo-window but the visible WT window carries the title set by process.title.

$ErrorActionPreference = "Continue"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

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

public class DesktopProbe {
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
    private static extern IntPtr GetForegroundWindow();

    private static readonly Guid CLSID_VirtualDesktopManager =
        new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a");

    // Returns true if any visible window titled `titlePart` lives on the current
    // virtual desktop, excluding the foreground window (the caller's own terminal).
    public static bool ExistsOnCurrentDesktop(string titlePart) {
        IVirtualDesktopManager vdm;
        try {
            Type t = Type.GetTypeFromCLSID(CLSID_VirtualDesktopManager);
            vdm = (IVirtualDesktopManager)Activator.CreateInstance(t);
        } catch {
            // COM unavailable (very old/locked-down Windows) — caller fails open.
            return false;
        }

        IntPtr foreground = GetForegroundWindow();
        bool found = false;

        EnumWindows((hWnd, lParam) => {
            if (hWnd == foreground) return true;          // skip our own terminal
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) < 0)
                return true;

            int onCurrent;
            // S_OK + onCurrent==1 means the window is on the active desktop.
            if (vdm.IsWindowOnCurrentVirtualDesktop(hWnd, out onCurrent) == 0 && onCurrent != 0) {
                found = true;
                return false; // stop enumerating
            }
            return true;
        }, IntPtr.Zero);

        return found;
    }
}
"@

if ([DesktopProbe]::ExistsOnCurrentDesktop("CLD CTRL")) {
    Write-Output "BLOCKED"
} else {
    Write-Output "OK"
}
