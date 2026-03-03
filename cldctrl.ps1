$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "CLD CTRL v4"
$script:CONFIG_VERSION = "4.0.0"
$script:scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:logFile = Join-Path $script:scriptDir "debug.log"
$script:logMaxBytes = 5 * 1024 * 1024  # 5MB rotation threshold

# ============================================================
# Feature 10: Structured JSON Logging
# ============================================================
function Write-DockLog {
    param([string]$Event, [hashtable]$Data = @{})
    try {
        # Log rotation: if > 5MB, rename to .bak
        if (Test-Path $script:logFile) {
            $fi = New-Object System.IO.FileInfo($script:logFile)
            if ($fi.Length -gt $script:logMaxBytes) {
                $bakPath = "$($script:logFile).bak"
                if (Test-Path $bakPath) { Remove-Item $bakPath -Force }
                Rename-Item $script:logFile $bakPath -Force
            }
        }
        $entry = @{
            ts    = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
            event = $Event
            data  = $Data
        }
        $json = $entry | ConvertTo-Json -Compress -Depth 4
        [System.IO.File]::AppendAllText($script:logFile, "$json`n")
    } catch { }
}

Write-DockLog "startup" @{ version = $script:CONFIG_VERSION }

# --- Single-instance guard using a named mutex ---
$script:singleInstanceMutex = New-Object System.Threading.Mutex($false, "Global\CldCtrl_SingleInstance")
if (-not $script:singleInstanceMutex.WaitOne(0, $false)) {
    Write-DockLog "startup_aborted" @{ reason = "Another instance is already running" }
    $script:singleInstanceMutex.Dispose()
    exit 0
}

try {

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Win32 API for virtual desktop window management and global hotkey ---
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class VDesktop {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}

public class HotkeyInterop {
    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public const int HOTKEY_ID = 9000;
    public const uint MOD_CTRL = 0x0002;
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_SHIFT = 0x0004;
    public const uint MOD_WIN = 0x0008;
    public const uint MONITOR_DEFAULTTONEAREST = 2;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWCP_ROUND = 2;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
}

public class HotkeyWindow : NativeWindow {
    private const int WM_HOTKEY = 0x0312;
    public event EventHandler HotkeyPressed;

    public HotkeyWindow() {
        CreateHandle(new CreateParams());
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HotkeyInterop.HOTKEY_ID) {
            if (HotkeyPressed != null) HotkeyPressed(this, EventArgs.Empty);
        }
        base.WndProc(ref m);
    }

    public void Destroy() {
        DestroyHandle();
    }
}
"@

# ============================================================
# Feature 5: Safety - Validate config schema
# ============================================================
function Test-ConfigValid {
    param($cfg)
    if (-not $cfg) { return $false }
    if (-not $cfg.PSObject.Properties['projects']) { return $false }
    # Allow empty projects array (zero-config first run discovers projects dynamically)
    if ($null -eq $cfg.projects) { return $true }
    if ($cfg.projects -isnot [System.Array] -and $cfg.projects -isnot [System.Object[]]) { return $false }
    foreach ($p in $cfg.projects) {
        if (-not $p.PSObject.Properties['name'] -or -not $p.PSObject.Properties['path']) { return $false }
        if ($p.name -isnot [string] -or $p.path -isnot [string]) { return $false }
    }
    return $true
}

# Atomic config write: write to .tmp then rename (safe against power loss / crash)
function Save-ConfigAtomic {
    $json = $script:config | ConvertTo-Json -Depth 4
    $tmpPath = "$($script:configPath).tmp"
    [System.IO.File]::WriteAllText($tmpPath, $json)
    if (Test-Path $script:configPath) { Remove-Item $script:configPath -Force }
    Rename-Item $tmpPath (Split-Path $script:configPath -Leaf)
}

# Feature 5: Path safety - allowlist approach for paths used in Start-Process args
function Test-PathSafe {
    param([string]$Path)
    # Only allow alphanumeric, spaces, backslash, forward slash, colon, dash, dot, underscore, parentheses
    if ($Path -notmatch '^[a-zA-Z0-9 \\/:\-._()]+$') { return $false }
    # Block path traversal via .. sequences
    if ($Path -match '\.\.') { return $false }
    return $true
}

# ============================================================
# External tool availability checks
# ============================================================
$script:ghAvailable = $false
try {
    $ghTest = & gh --version 2>$null
    if ($ghTest) { $script:ghAvailable = $true }
} catch { }

$script:gitAvailable = $false
try {
    $gitTest = & git --version 2>$null
    if ($gitTest) { $script:gitAvailable = $true }
} catch { }

$script:claudeAvailable = $false
try {
    $claudeTest = & claude --version 2>$null
    if ($claudeTest) { $script:claudeAvailable = $true }
} catch { }

$script:codeAvailable = $false
try {
    $codeTest = Get-Command code -ErrorAction SilentlyContinue
    if ($codeTest) { $script:codeAvailable = $true }
} catch { }

Write-DockLog "dependency_check" @{
    gh = $script:ghAvailable
    git = $script:gitAvailable
    claude = $script:claudeAvailable
    code = $script:codeAvailable
}

# ============================================================
# Load config
# ============================================================
$script:configPath = Join-Path $script:scriptDir "config.json"

if (-not (Test-Path $script:configPath)) {
    # Zero-config first run: auto-generate config from discovered Claude projects
    Write-DockLog "first_run" @{ message = "No config.json found, auto-generating" }
    $defaultProjects = @()
    $claudeProjDir = Join-Path $env:USERPROFILE ".claude\projects"
    if (Test-Path $claudeProjDir) {
        $slugDirs = Get-ChildItem -Path $claudeProjDir -Directory -ErrorAction SilentlyContinue
        foreach ($dir in $slugDirs) {
            # Reverse the slug to get the original path
            # Slug format: C-Users-name-path-to-project (drive letter dash separated)
            $settingsFile = Join-Path $dir.FullName "settings.json"
            $projectFile = Join-Path $dir.FullName "CLAUDE.md"
            # Try to find any .jsonl session file to confirm this is a real project
            $hasSession = Get-ChildItem -Path $dir.FullName -Filter "*.jsonl" -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $hasSession) { continue }

            # Reconstruct path from slug: first segment is drive letter, rest are path separators
            $parts = $dir.Name -split '-'
            if ($parts.Count -ge 2) {
                $driveLetter = $parts[0]
                $remaining = $parts[1..($parts.Count - 1)] -join '\'
                $projPath = "${driveLetter}:\$remaining"
                if (Test-Path $projPath) {
                    $projName = Split-Path $projPath -Leaf
                    $defaultProjects += [PSCustomObject]@{
                        name = $projName
                        path = $projPath
                    }
                }
            }
        }
    }

    $defaultConfig = [PSCustomObject]@{
        config_version = 4
        projects = $defaultProjects
        hidden_projects = @()
        launch = [PSCustomObject]@{
            explorer = $false
            vscode = $script:codeAvailable
            claude = $true
        }
        icon_color = "#DA8F4E"
        global_hotkey = [PSCustomObject]@{ modifiers = "Ctrl"; key = "Up" }
        project_manager = [PSCustomObject]@{ enabled = $true }
        notifications = [PSCustomObject]@{
            github_issues = [PSCustomObject]@{ enabled = $true; poll_interval_minutes = 5 }
            usage_stats = [PSCustomObject]@{ enabled = $true; show_tooltip = $true }
        }
    }

    $script:config = $defaultConfig
    try {
        $json = $defaultConfig | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($script:configPath, $json)
        Write-DockLog "first_run_config_created" @{ projects = $defaultProjects.Count }
    } catch {
        Write-DockLog "error" @{ function = "FirstRunConfig"; message = $_.Exception.Message }
    }
} else {
    try {
        $script:config = Get-Content $script:configPath -Raw | ConvertFrom-Json
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "config.json contains invalid JSON:`n$($_.Exception.Message)`n`nFix the file or delete it and recreate.",
            "CLD CTRL", "OK", "Error")
        Write-DockLog "error" @{ function = "LoadConfig"; message = $_.Exception.Message }
        exit 1
    }
}

# ============================================================
# Feature 11: Config schema migration
# ============================================================
function Migrate-Config {
    param($cfg)
    $migrated = $false

    # Version 1 (no version field) -> Version 2
    if (-not $cfg.PSObject.Properties['config_version'] -or $cfg.config_version -lt 2) {
        if (-not $cfg.PSObject.Properties['hidden_projects']) {
            $cfg | Add-Member -NotePropertyName 'hidden_projects' -NotePropertyValue @() -Force
        }
        if (-not $cfg.PSObject.Properties['global_hotkey']) {
            $hk = [PSCustomObject]@{ modifiers = "Ctrl"; key = "Up" }
            $cfg | Add-Member -NotePropertyName 'global_hotkey' -NotePropertyValue $hk -Force
        }
        $cfg | Add-Member -NotePropertyName 'config_version' -NotePropertyValue 2 -Force
        $migrated = $true
    }

    # Version 2 -> Version 3: add project_manager
    if ($cfg.config_version -lt 3) {
        if (-not $cfg.PSObject.Properties['project_manager']) {
            $pm = [PSCustomObject]@{ enabled = $true }
            $cfg | Add-Member -NotePropertyName 'project_manager' -NotePropertyValue $pm -Force
        }
        $cfg | Add-Member -NotePropertyName 'config_version' -NotePropertyValue 3 -Force
        $migrated = $true
    }

    # Version 3 -> Version 4: add notifications
    if ($cfg.config_version -lt 4) {
        if (-not $cfg.PSObject.Properties['notifications']) {
            $ghIssues = [PSCustomObject]@{ enabled = $true; poll_interval_minutes = 5 }
            $usageStats = [PSCustomObject]@{ enabled = $true; show_tooltip = $true }
            $notifications = [PSCustomObject]@{ github_issues = $ghIssues; usage_stats = $usageStats }
            $cfg | Add-Member -NotePropertyName 'notifications' -NotePropertyValue $notifications -Force
        }
        $cfg | Add-Member -NotePropertyName 'config_version' -NotePropertyValue 4 -Force
        $migrated = $true
    }

    if ($migrated) {
        try {
            # Use atomic write pattern (tmp+rename) to prevent corruption on crash
            $script:config = $cfg
            Save-ConfigAtomic
            Write-DockLog "config_migrated" @{ to_version = $cfg.config_version }
        } catch {
            Write-DockLog "error" @{ function = "Migrate-Config"; message = $_.Exception.Message }
        }
    }
    return $cfg
}

$script:config = Migrate-Config $script:config

# Feature 5: Validate config after migration
if (-not (Test-ConfigValid $script:config)) {
    [System.Windows.Forms.MessageBox]::Show(
        "config.json is invalid. Ensure it has a 'projects' array where each entry has 'name' and 'path' strings.",
        "CLD CTRL", "OK", "Error")
    exit 1
}

$script:pinnedProjects = if ($script:config.projects) { @($script:config.projects) } else { @() }
$script:launchOpts = $script:config.launch
$script:hiddenProjects = @()
if ($script:config.PSObject.Properties['hidden_projects']) {
    $script:hiddenProjects = @($script:config.hidden_projects)
}

# --- Load icon ---
$icoPath = Join-Path $script:scriptDir "cldctrl.ico"
if (Test-Path $icoPath) {
    $script:icon = New-Object System.Drawing.Icon($icoPath)
} else {
    $bmp = New-Object System.Drawing.Bitmap(64, 64)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.SmoothingMode = "AntiAlias"
    $gfx.Clear([System.Drawing.Color]::Transparent)
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(232, 118, 50))
    $gfx.FillEllipse($bgBrush, 2, 2, 60, 60)
    $font = New-Object System.Drawing.Font("Consolas", 20, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 30))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = "Center"
    $sf.LineAlignment = "Center"
    $gfx.DrawString("CD", $font, $textBrush, (New-Object System.Drawing.RectangleF(0, 0, 64, 64)), $sf)
    $bgBrush.Dispose(); $font.Dispose(); $textBrush.Dispose(); $sf.Dispose(); $gfx.Dispose()
    $hIcon = $bmp.GetHicon()
    # Clone so the Icon owns the handle, then free the original handle and bitmap
    $script:icon = ([System.Drawing.Icon]::FromHandle($hIcon)).Clone()
    [VDesktop]::DestroyIcon($hIcon) | Out-Null
    $bmp.Dispose()
}

# Pre-create icon bitmap for rendering in toast + launcher header
# Icon.ToBitmap() and DrawIcon() fail on PNG-compressed .ico entries in .NET Framework.
# Instead, load the .ico file directly as a Bitmap via MemoryStream (works because .NET
# Bitmap constructor can decode the embedded PNG data).
$script:iconBitmap = $null
if (Test-Path $icoPath) {
    try {
        $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
        $script:icoStream = New-Object System.IO.MemoryStream(,$icoBytes)
        $fullBmp = New-Object System.Drawing.Bitmap($script:icoStream)
        # Scale down to 32x32 for UI rendering
        $script:iconBitmap = New-Object System.Drawing.Bitmap(32, 32)
        $icGfx = [System.Drawing.Graphics]::FromImage($script:iconBitmap)
        $icGfx.SmoothingMode = "AntiAlias"
        $icGfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $icGfx.Clear([System.Drawing.Color]::Transparent)
        $icGfx.DrawImage($fullBmp, 0, 0, 32, 32)
        $icGfx.Dispose()
        $fullBmp.Dispose()
        # Keep $script:icoStream alive - Bitmap may reference it
    } catch {
        Write-DockLog "error" @{ function = "IconBitmap_FromStream"; message = $_.Exception.Message }
        $script:iconBitmap = $null
    }
}
# Fallback: generate "CD" circle if DrawIcon also failed
if (-not $script:iconBitmap) {
    $script:iconBitmap = New-Object System.Drawing.Bitmap(32, 32)
    $fbGfx = [System.Drawing.Graphics]::FromImage($script:iconBitmap)
    $fbGfx.SmoothingMode = "AntiAlias"
    $fbGfx.Clear([System.Drawing.Color]::Transparent)
    $fbBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(232, 118, 50))
    $fbGfx.FillEllipse($fbBrush, 1, 1, 30, 30)
    $fbFont = New-Object System.Drawing.Font("Consolas", 10, [System.Drawing.FontStyle]::Bold)
    $fbTextBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 30))
    $fbSf = New-Object System.Drawing.StringFormat
    $fbSf.Alignment = "Center"; $fbSf.LineAlignment = "Center"
    $fbGfx.DrawString("CD", $fbFont, $fbTextBrush, (New-Object System.Drawing.RectangleF(0, 0, 32, 32)), $fbSf)
    $fbBrush.Dispose(); $fbFont.Dispose(); $fbTextBrush.Dispose(); $fbSf.Dispose(); $fbGfx.Dispose()
}
Write-DockLog "icon_loaded" @{ bitmap_size = "$($script:iconBitmap.Width)x$($script:iconBitmap.Height)" }

# --- Claude sessions directory ---
$script:claudeProjectsDir = Join-Path $env:USERPROFILE ".claude\projects"

# ============================================================
# Bug fix: Get-ProjectSlug - chained .Replace() instead of regex
# ============================================================
function Get-ProjectSlug($path) {
    $slug = $path.Replace(':', '-').Replace('\', '-').Replace('/', '-').Replace(' ', '-').Replace('_', '-')
    return $slug
}

# ============================================================
# Feature 1: Session Stats
# ============================================================
$script:sessionStatsCache = @{}  # key: "filepath|filesize" -> value: @{Messages=N; Tokens=N}

function Format-TokenCount($tokens) {
    if ($tokens -ge 1000000) {
        return "{0:0.#}M" -f ($tokens / 1000000.0)
    } elseif ($tokens -ge 1000) {
        return "{0:0}k" -f ($tokens / 1000.0)
    } else {
        return "$tokens"
    }
}

function Get-SessionStats($sessionFilePath) {
    try {
        $fi = New-Object System.IO.FileInfo($sessionFilePath)
        # Feature 5: Skip files > 50MB
        if ($fi.Length -gt 50 * 1024 * 1024) { return $null }

        $cacheKey = "$sessionFilePath|$($fi.Length)"
        if ($script:sessionStatsCache.ContainsKey($cacheKey)) {
            return $script:sessionStatsCache[$cacheKey]
        }

        $messages = 0
        $tokens = 0
        $reader = New-Object System.IO.StreamReader($sessionFilePath)
        try {
            while ($null -ne ($line = $reader.ReadLine())) {
                # Count user messages
                if ($line -match '"type"\s*:\s*"user"') {
                    $messages++
                }
                # Sum token fields
                $tokenPatterns = @('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
                foreach ($tp in $tokenPatterns) {
                    if ($line -match "`"$tp`"\s*:\s*(\d+)") {
                        $tokens += [long]$Matches[1]
                    }
                }
            }
        } finally {
            $reader.Dispose()
        }

        $stats = @{ Messages = $messages; Tokens = $tokens }
        $script:sessionStatsCache[$cacheKey] = $stats
        return $stats
    } catch {
        Write-DockLog "error" @{ function = "Get-SessionStats"; message = $_.Exception.Message }
        return $null
    }
}

# ============================================================
# Sessions
# ============================================================
function Get-RecentSessions($projectPath, $maxSessions) {
    try {
        $slug = Get-ProjectSlug $projectPath
        $sessionDir = Join-Path $script:claudeProjectsDir $slug
        $sessions = @()

        if (Test-Path $sessionDir) {
            # Load sessions-index.json for Claude's AI-generated summaries
            $indexMap = @{}
            $indexPath = Join-Path $sessionDir "sessions-index.json"
            if (Test-Path $indexPath) {
                try {
                    $indexData = Get-Content $indexPath -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
                    if ($indexData.entries) {
                        foreach ($entry in $indexData.entries) {
                            if ($entry.sessionId) {
                                $indexMap[$entry.sessionId] = $entry
                            }
                        }
                    }
                } catch { }
            }

            $jsonlFiles = Get-ChildItem -Path $sessionDir -Filter "*.jsonl" -File |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First $maxSessions

            foreach ($file in $jsonlFiles) {
                $sessionId = $file.BaseName
                $modified = $file.LastWriteTime
                $summary = ""

                # Try sessions-index.json summary first (Claude's AI-generated titles)
                if ($indexMap.ContainsKey($sessionId) -and $indexMap[$sessionId].summary) {
                    $summary = $indexMap[$sessionId].summary
                    if ($summary.Length -gt 50) {
                        $summary = $summary.Substring(0, 47) + "..."
                    }
                }

                # Fall back to JSONL first-message extraction
                if (-not $summary) {
                    try {
                        $lines = Get-Content $file.FullName -TotalCount 10 -ErrorAction SilentlyContinue
                        foreach ($line in $lines) {
                            if ($line -match '"type":"user"' -and $line -match '"role":"user"') {
                                if ($line -match '"content":"([^"]{1,80})') {
                                    $summary = $Matches[1]
                                    $summary = $summary -replace '\\n', ' '
                                    $summary = $summary -replace '\\t', ' '
                                    if ($summary.Length -gt 50) {
                                        $summary = $summary.Substring(0, 47) + "..."
                                    }
                                }
                                break
                            }
                        }
                    } catch { }
                }

                if (-not $summary) {
                    $summary = $modified.ToString("MMM d, h:mm tt")
                }

                # Feature 1: Attach session stats
                $statsLabel = ""
                $stats = Get-SessionStats $file.FullName
                if ($stats -and $stats.Messages -gt 0) {
                    $tokLabel = Format-TokenCount $stats.Tokens
                    $statsLabel = "$($stats.Messages) msgs, $tokLabel tok"
                }

                $sessions += @{
                    Id         = $sessionId
                    Modified   = $modified
                    Summary    = $summary
                    DateLabel  = $modified.ToString("MMM d")
                    StatsLabel = $statsLabel
                    FilePath   = $file.FullName
                }
            }
        }
        return $sessions
    } catch {
        Write-DockLog "error" @{ function = "Get-RecentSessions"; message = $_.Exception.Message }
        return @()
    }
}

# ============================================================
# Feature 8: Session Preview
# ============================================================
function Get-SessionPreview($sessionFilePath) {
    try {
        $fi = New-Object System.IO.FileInfo($sessionFilePath)
        if ($fi.Length -gt 50 * 1024 * 1024) { return @() }
        $previews = @()
        $reader = New-Object System.IO.StreamReader($sessionFilePath)
        try {
            while ($null -ne ($line = $reader.ReadLine()) -and $previews.Count -lt 3) {
                if ($line -match '"type"\s*:\s*"user"' -and $line -match '"role"\s*:\s*"user"') {
                    if ($line -match '"content"\s*:\s*"([^"]{1,120})') {
                        $msg = $Matches[1] -replace '\\n', ' ' -replace '\\t', ' '
                        if ($msg.Length -gt 70) { $msg = $msg.Substring(0, 67) + "..." }
                        $previews += $msg
                    }
                }
            }
        } finally {
            $reader.Dispose()
        }
        return $previews
    } catch {
        return @()
    }
}

# ============================================================
# Git Status (Feature 5: error boundary + timeout consideration)
# ============================================================
function Get-GitStatus($projectPath) {
    try {
        if (-not $script:gitAvailable) { return "" }
        $gitDir = Join-Path $projectPath ".git"
        if (-not (Test-Path $gitDir)) { return "" }

        $branch = & git -C $projectPath rev-parse --abbrev-ref HEAD 2>$null
        if (-not $branch) { return "" }

        $statusOutput = & git -C $projectPath status --porcelain 2>$null
        $dirty = 0
        if ($statusOutput) {
            $dirty = ($statusOutput | Measure-Object).Count
        }

        $unpushed = 0
        $upstream = & git -C $projectPath rev-parse --abbrev-ref "@{upstream}" 2>$null
        if ($upstream) {
            $unpushedOutput = & git -C $projectPath rev-list "$upstream..HEAD" 2>$null
            if ($unpushedOutput) {
                $unpushed = ($unpushedOutput | Measure-Object).Count
            }
        }

        $upArrow = [char]0x2191
        $bullet = [char]0x25CF
        $check = [char]0x2713
        $status = "($branch"
        if ($unpushed -gt 0) { $status += " $upArrow$unpushed" }
        if ($dirty -gt 0) { $status += " $bullet$dirty" }
        if ($unpushed -eq 0 -and $dirty -eq 0) { $status += " $check" }
        $status += ")"
        return $status
    } catch {
        Write-DockLog "error" @{ function = "Get-GitStatus"; message = $_.Exception.Message }
        return ""
    }
}

# Background git status refresh - fetches statuses without blocking the UI
$script:gitRefreshPending = $false
$script:gitRefreshJob = $null

function Start-GitStatusRefresh {
    if (-not $script:gitAvailable) { return }
    # Collect project paths that have .git dirs
    $paths = @()
    foreach ($proj in $script:allProjects) {
        $paths += $proj.path
    }
    # Clean up any orphaned previous job
    if ($script:gitRefreshJob) {
        try { Remove-Job -Job $script:gitRefreshJob -Force -ErrorAction SilentlyContinue } catch { }
    }
    $script:gitRefreshJob = Start-Job -ScriptBlock {
        param($projectPaths)
        $results = @{}
        foreach ($p in $projectPaths) {
            try {
                $gitDir = Join-Path $p ".git"
                if (-not (Test-Path $gitDir)) { $results[$p] = ""; continue }
                $branch = & git -C $p rev-parse --abbrev-ref HEAD 2>$null
                if (-not $branch) { $results[$p] = ""; continue }
                $statusOutput = & git -C $p status --porcelain 2>$null
                $dirty = 0
                if ($statusOutput) { $dirty = ($statusOutput | Measure-Object).Count }
                $unpushed = 0
                $upstream = & git -C $p rev-parse --abbrev-ref "@{upstream}" 2>$null
                if ($upstream) {
                    $unpushedOutput = & git -C $p rev-list "$upstream..HEAD" 2>$null
                    if ($unpushedOutput) { $unpushed = ($unpushedOutput | Measure-Object).Count }
                }
                $upArrow = [char]0x2191; $bullet = [char]0x25CF; $check = [char]0x2713
                $status = "($branch"
                if ($unpushed -gt 0) { $status += " $upArrow$unpushed" }
                if ($dirty -gt 0) { $status += " $bullet$dirty" }
                if ($unpushed -eq 0 -and $dirty -eq 0) { $status += " $check" }
                $status += ")"
                $results[$p] = $status
            } catch { $results[$p] = "" }
        }
        return $results
    } -ArgumentList (,$paths)
}

function Collect-GitStatusResults {
    if (-not $script:gitRefreshJob) { return $false }
    if ($script:gitRefreshJob.State -eq 'Completed') {
        try {
            $results = Receive-Job -Job $script:gitRefreshJob -ErrorAction SilentlyContinue
            if ($results -and $results -is [hashtable]) {
                foreach ($proj in $script:allProjects) {
                    if ($results.ContainsKey($proj.path)) {
                        $script:launcherGitStatuses[$proj.name] = $results[$proj.path]
                    }
                }
                $script:gitRefreshPending = $false
                return $true
            }
        } catch { }
        Remove-Job -Job $script:gitRefreshJob -Force -ErrorAction SilentlyContinue
        $script:gitRefreshJob = $null
        return $false
    } elseif ($script:gitRefreshJob.State -eq 'Failed') {
        Remove-Job -Job $script:gitRefreshJob -Force -ErrorAction SilentlyContinue
        $script:gitRefreshJob = $null
    }
    return $false
}

# ============================================================
# Feature 3: GitHub Issues
# ============================================================
$script:issueCache = @{}       # key: "owner/repo" -> @{ Issues=@(); FetchedAt=[datetime] }
$script:issueCacheTTL = 300    # 5 minutes in seconds
$script:issueJobs = @{}        # key: "owner/repo" -> Job object
$script:issueTimer = $null

function Get-GitHubRepo($projectPath) {
    try {
        if (-not $script:ghAvailable) { return $null }
        $gitDir = Join-Path $projectPath ".git"
        if (-not (Test-Path $gitDir)) { return $null }
        $remoteUrl = & git -C $projectPath remote get-url origin 2>$null
        if (-not $remoteUrl) { return $null }
        # Parse owner/repo from various URL formats
        if ($remoteUrl -match 'github\.com[:/]([^/]+)/([^/.]+?)(?:\.git)?$') {
            return "$($Matches[1])/$($Matches[2])"
        }
        return $null
    } catch {
        return $null
    }
}

function Start-IssueFetch($ownerRepo) {
    if (-not $script:ghAvailable) { return }
    if (-not $ownerRepo) { return }
    # Check cache
    if ($script:issueCache.ContainsKey($ownerRepo)) {
        $cached = $script:issueCache[$ownerRepo]
        if (((Get-Date) - $cached.FetchedAt).TotalSeconds -lt $script:issueCacheTTL) { return }
    }
    # Don't start duplicate jobs
    if ($script:issueJobs.ContainsKey($ownerRepo) -and $script:issueJobs[$ownerRepo].State -eq 'Running') { return }

    $script:issueJobs[$ownerRepo] = Start-Job -ScriptBlock {
        param($repo)
        try {
            $result = & gh issue list --repo $repo --state open --limit 20 --json number,title,labels 2>$null
            if ($result) { return $result }
        } catch { }
        return "[]"
    } -ArgumentList $ownerRepo
}

function Collect-IssueResults {
    $changed = $false
    $completedKeys = @()
    if (-not $script:issueJobs -or $script:issueJobs.Count -eq 0) { return $false }
    $keys = @($script:issueJobs.Keys)
    foreach ($key in $keys) {
        $job = $script:issueJobs[$key]
        if (-not $job) { $completedKeys += $key; continue }
        if ($job.State -eq 'Completed') {
            try {
                $result = Receive-Job -Job $job -ErrorAction SilentlyContinue
                if ($result) {
                    $issues = $result | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($null -eq $issues) { $issues = @() }
                    $script:issueCache[$key] = @{ Issues = @($issues); FetchedAt = Get-Date }
                    $changed = $true
                }
            } catch { }
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
            $completedKeys += $key
        } elseif ($job.State -eq 'Failed') {
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
            $completedKeys += $key
        }
    }
    foreach ($key in $completedKeys) {
        $script:issueJobs.Remove($key)
    }
    return $changed
}

function Get-IssueCount($ownerRepo) {
    if (-not $ownerRepo) { return 0 }
    if ($script:issueCache.ContainsKey($ownerRepo)) {
        return $script:issueCache[$ownerRepo].Issues.Count
    }
    return 0
}

# ============================================================
# Feature 16: Seen-issues persistence (notification dedup)
# ============================================================
$script:seenIssueIds = @{}
$script:seenIssueIdsPath = Join-Path $script:scriptDir "seen-issues.json"
$script:lastIssuePollTime = [datetime]::MinValue

function Load-SeenIssueIds {
    try {
        if (Test-Path $script:seenIssueIdsPath) {
            $raw = Get-Content $script:seenIssueIdsPath -Raw -ErrorAction SilentlyContinue
            if ($raw) {
                $parsed = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($parsed) {
                    $script:seenIssueIds = @{}
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $script:seenIssueIds[$prop.Name] = @($prop.Value)
                    }
                }
            }
        }
    } catch {
        Write-DockLog "error" @{ function = "Load-SeenIssueIds"; message = $_.Exception.Message }
    }
}

function Save-SeenIssueIds {
    try {
        $json = $script:seenIssueIds | ConvertTo-Json -Depth 4 -Compress
        $tmpPath = "$($script:seenIssueIdsPath).tmp"
        [System.IO.File]::WriteAllText($tmpPath, $json)
        if (Test-Path $script:seenIssueIdsPath) { Remove-Item $script:seenIssueIdsPath -Force }
        Rename-Item $tmpPath (Split-Path $script:seenIssueIdsPath -Leaf)
    } catch {
        Write-DockLog "error" @{ function = "Save-SeenIssueIds"; message = $_.Exception.Message }
    }
}

Load-SeenIssueIds

# ============================================================
# Feature 16: Issue Notification Detection
# ============================================================
function Check-NewIssueNotifications {
    try {
        if (-not $script:config.PSObject.Properties['notifications']) { return }
        $ghCfg = $script:config.notifications.github_issues
        if (-not $ghCfg -or -not $ghCfg.enabled) { return }

        $newestIssue = $null
        $newestRepo = $null
        $changed = $false

        foreach ($repo in @($script:issueCache.Keys)) {
            $cached = $script:issueCache[$repo]
            if (-not $cached -or -not $cached.Issues) { continue }
            $currentIds = @($cached.Issues | ForEach-Object { $_.number })

            if (-not $script:seenIssueIds.ContainsKey($repo)) {
                # First encounter: seed with all current IDs (no notification flood)
                $script:seenIssueIds[$repo] = $currentIds
                $changed = $true
                Write-DockLog "seen_issues_seeded" @{ repo = $repo; count = $currentIds.Count }
                continue
            }

            $seenSet = @($script:seenIssueIds[$repo])
            $hasNew = $false
            foreach ($issue in $cached.Issues) {
                if ($seenSet -notcontains $issue.number) {
                    # New issue found
                    $newestIssue = $issue
                    $newestRepo = $repo
                    $hasNew = $true
                    Write-DockLog "new_issue_detected" @{ repo = $repo; number = $issue.number; title = $issue.title }
                }
            }
            # Only update seen IDs if the set actually changed
            if ($hasNew) {
                $script:seenIssueIds[$repo] = $currentIds
                $changed = $true
            }
        }

        if ($changed) { Save-SeenIssueIds }

        # Show balloon for newest issue (only 1 per poll cycle to avoid spam)
        if ($newestIssue -and $script:notifyIcon) {
            $balloonTitle = "New issue in $newestRepo"
            $balloonText = "#$($newestIssue.number): $($newestIssue.title)"
            if ($balloonText.Length -gt 200) { $balloonText = $balloonText.Substring(0, 197) + "..." }
            $script:notifyIcon.ShowBalloonTip(5000, $balloonTitle, $balloonText, [System.Windows.Forms.ToolTipIcon]::Info)
            Write-DockLog "balloon_shown" @{ repo = $newestRepo; issue = $newestIssue.number }
        }
    } catch {
        Write-DockLog "error" @{ function = "Check-NewIssueNotifications"; message = $_.Exception.Message }
    }
}

function Start-BackgroundIssuePoll {
    try {
        foreach ($proj in $script:allProjects) {
            $repo = $null
            if ($script:projectGhRepos.ContainsKey($proj.path)) {
                $repo = $script:projectGhRepos[$proj.path]
            }
            if ($repo) {
                Start-IssueFetch $repo
            }
        }
        $script:lastIssuePollTime = Get-Date
    } catch {
        Write-DockLog "error" @{ function = "Start-BackgroundIssuePoll"; message = $_.Exception.Message }
    }
}

# ============================================================
# Feature 17: Usage Stats on Tray Tooltip
# ============================================================
$script:usageStatsJob = $null
$script:lastTooltipUpdate = [datetime]::MinValue
$script:cachedTooltipStats = @{ Tokens = 0; Messages = 0 }

function Start-UsageStatsJob {
    try {
        if (-not $script:config.PSObject.Properties['notifications']) { return }
        $usCfg = $script:config.notifications.usage_stats
        if (-not $usCfg -or -not $usCfg.enabled) { return }

        # Skip if previous job is still running (don't kill it)
        if ($script:usageStatsJob -and $script:usageStatsJob.State -eq 'Running') {
            Write-DockLog "usage_stats_skipped" @{ reason = "previous job still running" }
            return
        }
        # Clean up completed/failed previous job
        if ($script:usageStatsJob) {
            try { Remove-Job -Job $script:usageStatsJob -Force -ErrorAction SilentlyContinue } catch { }
        }

        $claudeDir = $script:claudeProjectsDir
        $script:usageStatsJob = Start-Job -ScriptBlock {
            param($projectsDir)
            $totalTokens = [long]0
            $totalMessages = 0
            $today = (Get-Date).Date
            try {
                if (-not (Test-Path $projectsDir)) { return @{ Tokens = 0; Messages = 0 } }
                $slugDirs = Get-ChildItem -Path $projectsDir -Directory -ErrorAction SilentlyContinue
                foreach ($slugDir in $slugDirs) {
                    $files = Get-ChildItem -Path $slugDir.FullName -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                        Where-Object { $_.LastWriteTime.Date -eq $today }
                    foreach ($file in $files) {
                        if ($file.Length -gt 50 * 1024 * 1024) { continue }
                        $reader = New-Object System.IO.StreamReader($file.FullName)
                        try {
                            while ($null -ne ($line = $reader.ReadLine())) {
                                if ($line -match '"type"\s*:\s*"user"') {
                                    $totalMessages++
                                }
                                foreach ($tp in @('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')) {
                                    if ($line -match "`"$tp`"\s*:\s*(\d+)") {
                                        $totalTokens += [long]$Matches[1]
                                    }
                                }
                            }
                        } finally {
                            $reader.Dispose()
                        }
                    }
                }
            } catch {
                # Return partial results on error
            }
            return @{ Tokens = $totalTokens; Messages = $totalMessages }
        } -ArgumentList $claudeDir
    } catch {
        Write-DockLog "error" @{ function = "Start-UsageStatsJob"; message = $_.Exception.Message }
    }
}

function Collect-UsageStatsResult {
    if (-not $script:usageStatsJob) { return }
    try {
        if ($script:usageStatsJob.State -eq 'Completed') {
            try {
                $result = Receive-Job -Job $script:usageStatsJob -ErrorAction SilentlyContinue
                # PS 5.1 deserializes hashtables from jobs as PSObject, not [hashtable]
                if ($result -and $result.PSObject.Properties['Tokens'] -and $result.PSObject.Properties['Messages']) {
                    $script:cachedTooltipStats = @{
                        Tokens   = [long]$result.Tokens
                        Messages = [int]$result.Messages
                    }
                }
            } catch {
                Write-DockLog "error" @{ function = "Collect-UsageStatsResult"; message = $_.Exception.Message }
            }
            Remove-Job -Job $script:usageStatsJob -Force -ErrorAction SilentlyContinue
            $script:usageStatsJob = $null
            Update-TrayTooltip
        } elseif ($script:usageStatsJob.State -eq 'Failed') {
            Remove-Job -Job $script:usageStatsJob -Force -ErrorAction SilentlyContinue
            $script:usageStatsJob = $null
        }
    } catch {
        Write-DockLog "error" @{ function = "Collect-UsageStatsResult"; message = $_.Exception.Message }
    }
}

function Update-TrayTooltip {
    try {
        if (-not $script:notifyIcon) { return }
        if (-not $script:config.PSObject.Properties['notifications']) {
            $script:notifyIcon.Text = "CLD CTRL"
            return
        }
        $usCfg = $script:config.notifications.usage_stats
        if (-not $usCfg -or -not $usCfg.enabled -or -not $usCfg.show_tooltip) {
            $script:notifyIcon.Text = "CLD CTRL"
            return
        }
        $tok = $script:cachedTooltipStats.Tokens
        $msgs = $script:cachedTooltipStats.Messages
        if ($tok -eq 0 -and $msgs -eq 0) {
            $script:notifyIcon.Text = "CLD CTRL"
            return
        }
        # Format tokens
        $tokLabel = ""
        if ($tok -ge 1000000) { $tokLabel = "{0:0.#}M" -f ($tok / 1000000.0) }
        elseif ($tok -ge 1000) { $tokLabel = "{0:0}k" -f ($tok / 1000.0) }
        else { $tokLabel = "$tok" }
        $tip = "CLD CTRL | Today: $($tokLabel) tok, $msgs msgs"
        # NotifyIcon.Text max is 63 chars
        if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
        $script:notifyIcon.Text = $tip
    } catch {
        Write-DockLog "error" @{ function = "Update-TrayTooltip"; message = $_.Exception.Message }
    }
}

# ============================================================
# Feature 2: Auto-Discovery of Projects
# ============================================================
$script:allProjects = @()        # merged list: pinned + discovered
$script:projectGhRepos = @{}     # project path -> "owner/repo" or $null

# Scrollable project list state
$script:INITIAL_VISIBLE_COUNT = 12
$script:MAX_VIEWPORT_ITEMS = 12
$script:scrollOffset = 0
$script:scrollActivated = $false

function Get-ProjectPathFromSlug($slugDir) {
    try {
        $sessionFiles = Get-ChildItem -Path $slugDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if (-not $sessionFiles) { return $null }
        # Read first 20 lines — cwd may not be on line 1 (file-history-snapshot comes first)
        $lines = Get-Content $sessionFiles.FullName -TotalCount 20 -ErrorAction SilentlyContinue
        foreach ($line in $lines) {
            if ($line -and $line -match '"cwd"\s*:\s*"([^"]+)"') {
                $cwdPath = $Matches[1] -replace '\\\\', '\'
                if (Test-Path $cwdPath) { return $cwdPath }
            }
        }
        return $null
    } catch {
        return $null
    }
}

function Get-DiscoveredProjects {
    try {
        if (-not (Test-Path $script:claudeProjectsDir)) { return @() }
        $pinnedPaths = @{}
        foreach ($p in $script:pinnedProjects) {
            $pinnedPaths[$p.path.ToLower()] = $true
        }
        $hiddenPaths = @{}
        foreach ($h in $script:hiddenProjects) {
            $hiddenPaths[$h.ToLower()] = $true
        }

        $discovered = @()
        $slugDirs = Get-ChildItem -Path $script:claudeProjectsDir -Directory -ErrorAction SilentlyContinue
        foreach ($dir in $slugDirs) {
            $projPath = Get-ProjectPathFromSlug $dir.FullName
            if (-not $projPath) { continue }
            $pathLower = $projPath.ToLower()
            if ($pinnedPaths.ContainsKey($pathLower)) { continue }
            if ($hiddenPaths.ContainsKey($pathLower)) { continue }

            # Derive name from path (last folder component)
            $projName = Split-Path $projPath -Leaf
            # Get last activity from most recent session file
            $lastSession = Get-ChildItem -Path $dir.FullName -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            $lastActivity = if ($lastSession) { $lastSession.LastWriteTime } else { [datetime]::MinValue }

            $discovered += @{
                name         = $projName
                path         = $projPath
                lastActivity = $lastActivity
                isDiscovered = $true
            }
        }

        # Sort by last activity descending
        $discovered = $discovered | Sort-Object { $_.lastActivity } -Descending
        return $discovered
    } catch {
        Write-DockLog "error" @{ function = "Get-DiscoveredProjects"; message = $_.Exception.Message }
        return @()
    }
}

function Build-ProjectList {
    $script:allProjects = @()

    # Pinned projects first (with lastActivity lookup)
    foreach ($p in $script:pinnedProjects) {
        $lastActivity = [datetime]::MinValue
        try {
            $slug = Get-ProjectSlug $p.path
            $slugDir = Join-Path $script:claudeProjectsDir $slug
            if (Test-Path $slugDir) {
                $lastSession = Get-ChildItem -Path $slugDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                    Sort-Object LastWriteTime -Descending | Select-Object -First 1
                if ($lastSession) { $lastActivity = $lastSession.LastWriteTime }
            }
        } catch { }
        $script:allProjects += @{
            name         = $p.name
            path         = $p.path
            hotkey       = if ($p.PSObject.Properties['hotkey']) { $p.hotkey } else { $null }
            isPinned     = $true
            isDiscovered = $false
            lastActivity = $lastActivity
        }
    }

    # Discovered projects (no cap — scrolling handles display)
    $discoveredList = Get-DiscoveredProjects
    foreach ($d in $discoveredList) {
        $script:allProjects += @{
            name         = $d.name
            path         = $d.path
            hotkey       = $null
            isPinned     = $false
            isDiscovered = $true
            lastActivity = $d.lastActivity
        }
    }

    # Cache GitHub repos for all projects
    $script:projectGhRepos = @{}
    foreach ($proj in $script:allProjects) {
        $script:projectGhRepos[$proj.path] = Get-GitHubRepo $proj.path
    }
}

function Toggle-HiddenProject($projectPath) {
    try {
        $pathLower = $projectPath.ToLower()
        $idx = -1
        for ($i = 0; $i -lt $script:hiddenProjects.Count; $i++) {
            if ($script:hiddenProjects[$i].ToLower() -eq $pathLower) { $idx = $i; break }
        }
        if ($idx -ge 0) {
            # Unhide
            $script:hiddenProjects = @($script:hiddenProjects | Where-Object { $_.ToLower() -ne $pathLower })
        } else {
            # Hide
            $script:hiddenProjects += $projectPath
        }
        $script:config.hidden_projects = $script:hiddenProjects
        Save-ConfigAtomic
        Write-DockLog "project_hidden_toggled" @{ path = $projectPath }
    } catch {
        Write-DockLog "error" @{ function = "Toggle-HiddenProject"; message = $_.Exception.Message }
    }
}

# Right-click pin/unpin toggle
function Toggle-PinnedProject($projectPath, $projectName) {
    try {
        $pathLower = $projectPath.ToLower()
        $found = $false
        $newPinned = @()
        foreach ($p in $script:pinnedProjects) {
            if ($p.path.ToLower() -eq $pathLower) {
                $found = $true  # skip = unpin
            } else {
                $newPinned += $p
            }
        }
        if (-not $found) {
            # Pin: add to pinned list
            $newPinned += [PSCustomObject]@{ name = $projectName; path = $projectPath }
        }
        # Save to disk first, then update in-memory state (prevents divergence on write failure)
        $savedPinned = $script:pinnedProjects
        $savedProjects = $script:config.projects
        $script:pinnedProjects = $newPinned
        $script:config.projects = @($newPinned)
        try {
            Save-ConfigAtomic
        } catch {
            # Revert in-memory state on write failure
            $script:pinnedProjects = $savedPinned
            $script:config.projects = $savedProjects
            throw
        }
        Write-DockLog "project_pin_toggled" @{ path = $projectPath; pinned = (-not $found) }
        Build-ProjectList
        $script:launcherAccelMap = Get-AcceleratorMap
        Build-LauncherPhase1
        $script:highlightIndex = 0
        $size = Get-LauncherSize
        if ($script:launcherForm) {
            $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
            $script:launcherForm.Invalidate()
        }
    } catch {
        Write-DockLog "error" @{ function = "Toggle-PinnedProject"; message = $_.Exception.Message }
    }
}

# Script-scope vars for right-click context menu (PS 5.1 closure workaround)
$script:rightClickProjectPath = ""
$script:rightClickProjectName = ""
$script:rightClickIsPinned = $false
$script:contextMenuOpen = $false

# ============================================================
# Accelerator key assignment (updated for allProjects + reserved keys)
# ============================================================
function Get-AcceleratorMap {
    $map = @{}
    $usedKeys = @{}
    # Reserve system keys
    $usedKeys['H'] = $true   # H = hide/unhide
    $usedKeys['I'] = $true   # I = issues (Phase 2)
    $usedKeys['U'] = $true   # U = update check
    $usedKeys['M'] = $true   # M = project manager

    # First pass: honor per-project config overrides
    foreach ($proj in $script:allProjects) {
        if ($proj.hotkey) {
            $key = $proj.hotkey.ToString().ToUpper()[0]
            $map[$proj.name] = $key
            $usedKeys[$key] = $true
        }
    }

    # Second pass: auto-assign
    foreach ($proj in $script:allProjects) {
        if ($map.ContainsKey($proj.name)) { continue }
        $name = $proj.name
        $assigned = $false

        # Strategy 1: first letter
        $firstChar = $name.ToUpper()[0]
        if (-not $usedKeys.ContainsKey($firstChar) -and $firstChar -match '[A-Z]') {
            $map[$name] = $firstChar
            $usedKeys[$firstChar] = $true
            $assigned = $true
        }

        # Strategy 2: word-start letters
        if (-not $assigned) {
            $words = $name -split '\s+'
            foreach ($word in $words) {
                if ($word.Length -eq 0) { continue }
                $c = $word.ToUpper()[0]
                if (-not $usedKeys.ContainsKey($c) -and $c -match '[A-Z]') {
                    $map[$name] = $c
                    $usedKeys[$c] = $true
                    $assigned = $true
                    break
                }
            }
        }

        # Strategy 3: consonants
        if (-not $assigned) {
            foreach ($ch in $name.ToUpper().ToCharArray()) {
                if ($ch -match '[A-Z]' -and $ch -notmatch '[AEIOU]' -and -not $usedKeys.ContainsKey($ch)) {
                    $map[$name] = $ch
                    $usedKeys[$ch] = $true
                    $assigned = $true
                    break
                }
            }
        }

        # Strategy 4: any letter
        if (-not $assigned) {
            foreach ($ch in $name.ToUpper().ToCharArray()) {
                if ($ch -match '[A-Z]' -and -not $usedKeys.ContainsKey($ch)) {
                    $map[$name] = $ch
                    $usedKeys[$ch] = $true
                    $assigned = $true
                    break
                }
            }
        }

        # Strategy 5: digits
        if (-not $assigned) {
            for ($d = 1; $d -le 9; $d++) {
                $dc = [char]([int][char]'0' + $d)
                if (-not $usedKeys.ContainsKey($dc)) {
                    $map[$name] = $dc
                    $usedKeys[$dc] = $true
                    break
                }
            }
        }
    }
    return $map
}

# ============================================================
# Feature 9: Auto-Update Check
# ============================================================
$script:updateAvailable = $false
$script:updateVersion = ""
$script:updateCacheFile = Join-Path $env:TEMP "cldctrl_update_cache.json"

function Check-ForUpdate {
    if (-not $script:ghAvailable) { return }
    try {
        # Check 24-hour cache
        if (Test-Path $script:updateCacheFile) {
            $cacheContent = Get-Content $script:updateCacheFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($cacheContent -and $cacheContent.PSObject.Properties['checked_at']) {
                $checkedAt = [datetime]::Parse($cacheContent.checked_at)
                if (((Get-Date) - $checkedAt).TotalHours -lt 24) {
                    if ($cacheContent.PSObject.Properties['latest_version'] -and $cacheContent.latest_version -ne $script:CONFIG_VERSION) {
                        $script:updateAvailable = $true
                        $script:updateVersion = $cacheContent.latest_version
                    }
                    return
                }
            }
        }
    } catch { }

    # Background job to check
    Start-Job -ScriptBlock {
        try {
            $result = & gh release view --repo RyanSeanPhillips/cldctrl --json tagName 2>$null
            if ($result) { return $result }
        } catch { }
        return $null
    } | ForEach-Object {
        $script:updateCheckJob = $_
    }
}

function Collect-UpdateResult {
    if (-not $script:updateCheckJob) { return }
    if ($script:updateCheckJob.State -eq 'Completed') {
        try {
            $result = Receive-Job -Job $script:updateCheckJob -ErrorAction SilentlyContinue
            if ($result) {
                $data = $result | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($data -and $data.PSObject.Properties['tagName']) {
                    $latestVer = $data.tagName -replace '^v', ''
                    # Write cache
                    $cacheData = @{ checked_at = (Get-Date).ToString("o"); latest_version = $latestVer } | ConvertTo-Json -Compress
                    [System.IO.File]::WriteAllText($script:updateCacheFile, $cacheData)
                    if ($latestVer -ne $script:CONFIG_VERSION) {
                        $script:updateAvailable = $true
                        $script:updateVersion = $latestVer
                    }
                }
            }
        } catch { }
        Remove-Job -Job $script:updateCheckJob -Force -ErrorAction SilentlyContinue
        $script:updateCheckJob = $null
    }
}

$script:updateCheckJob = $null
Check-ForUpdate

# ============================================================
# Launcher Form State
# ============================================================
$script:launcherForm = $null
$script:currentPhase = 1
$script:highlightIndex = 0
$script:selectedProjectIndex = -1
$script:launcherItems = @()
$script:launcherAccelMap = @{}
$script:launcherSessions = @()
$script:launcherGitStatuses = @{}
$script:filterText = ""            # Feature 6: fuzzy search state
$script:filteredItems = @()        # Feature 6: filtered items
$script:selectedGhRepo = $null     # Feature 3: current project's GH repo
$script:previewData = @()          # Feature 8: session preview lines
$script:previewIndex = -1          # Feature 8: which item is being previewed
$script:hoverTimer = $null         # Feature 8: 500ms hover timer
$script:activeToast = $null        # Feature 7: current toast form
$script:activeToastTimer = $null   # Feature 7: current toast timer

# ============================================================
# Feature 6: Fuzzy Search / Type-to-Filter
# ============================================================
function Get-FilteredItems {
    if ($script:filterText.Length -gt 0) {
        $script:scrollOffset = 0
        $script:scrollActivated = $false
    }
    if ($script:filterText.Length -eq 0) {
        $script:filteredItems = @($script:launcherItems)
        return
    }
    $filter = $script:filterText.ToLower()
    $script:filteredItems = @($script:launcherItems | Where-Object {
        $_.Label.ToLower().Contains($filter)
    })
}

function Get-VisibleItems {
    if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0) {
        return $script:filteredItems
    }
    return $script:launcherItems
}

# Viewport slicing for Phase 1 scrollable list
function Get-ViewportItems {
    $allItems = Get-VisibleItems
    # Only slice in Phase 1 when not filtering
    if ($script:currentPhase -ne 1 -or $script:filterText.Length -gt 0) {
        return $allItems
    }
    $total = $allItems.Count
    $maxVisible = if ($script:scrollActivated) { $script:MAX_VIEWPORT_ITEMS } else { $script:INITIAL_VISIBLE_COUNT }
    if ($total -le $maxVisible) {
        return $allItems
    }
    $end = [Math]::Min($script:scrollOffset + $maxVisible, $total)
    $start = $script:scrollOffset
    return @($allItems[$start..($end - 1)])
}

# ============================================================
# Launcher Sizing and Layout
# ============================================================
function Get-LauncherSize {
    $items = Get-ViewportItems
    $itemCount = $items.Count
    $width = 420  # Feature 2: wider for longer project names
    $headerH = 36
    $separatorH = 1
    $itemH = 30
    $footerH = 28
    $padding = 8
    $filterBarH = 0
    if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0) { $filterBarH = 28 }
    $extraSep = 0
    if ($script:currentPhase -eq 2) {
        $hasSessions = ($items | Where-Object { $_.Type -eq "session" -or $_.Type -eq "pm-session" }).Count -gt 0
        if ($hasSessions) { $extraSep = 9 }
    }
    # Separators in Phase 1 — walk viewport items to match paint logic exactly
    if ($script:currentPhase -eq 1) {
        $discoveredSepCounted = $false
        for ($si = 0; $si -lt $items.Count; $si++) {
            # Project Manager separator (4px after the manager item)
            if ($si -gt 0 -and $items[$si - 1].ContainsKey('isSeparatorAfter') -and $items[$si - 1].isSeparatorAfter) {
                $extraSep += 4
            }
            # Discovered section separator (18px: line + label)
            if ($items[$si].isDiscovered -and -not $discoveredSepCounted) {
                $extraSep += 18
                $discoveredSepCounted = $true
            }
        }
    }
    # Scroll indicators height
    $scrollIndicatorH = 0
    if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0) {
        $allItems = Get-VisibleItems
        if ($script:scrollOffset -gt 0) { $scrollIndicatorH += 14 }
        $maxVisible = if ($script:scrollActivated) { $script:MAX_VIEWPORT_ITEMS } else { $script:INITIAL_VISIBLE_COUNT }
        if (($script:scrollOffset + $maxVisible) -lt $allItems.Count) { $scrollIndicatorH += 14 }
    }
    # Feature 8: preview expansion
    $previewH = 0
    if ($script:previewData.Count -gt 0 -and $script:previewIndex -ge 0) {
        $previewH = $script:previewData.Count * 16 + 4
    }
    $height = $headerH + $filterBarH + $separatorH + ($itemCount * $itemH) + $extraSep + $scrollIndicatorH + $previewH + $separatorH + $footerH + $padding
    return @{ Width = $width; Height = [Math]::Min($height, 700) }
}

# ============================================================
# Show / Hide Launcher
# ============================================================
function Show-Launcher {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        # Flush stale session stats cache on each open
        $script:sessionStatsCache = @{}

        # Build project list fresh
        Build-ProjectList

        # Refresh accelerators; use CACHED git statuses first (show instantly)
        $script:launcherAccelMap = Get-AcceleratorMap

        # Start background issue fetches
        foreach ($proj in $script:allProjects) {
            $ghRepo = $script:projectGhRepos[$proj.path]
            if ($ghRepo) { Start-IssueFetch $ghRepo }
        }

        $script:currentPhase = 1
        $script:highlightIndex = 0
        $script:selectedProjectIndex = -1
        $script:filterText = ""
        $script:scrollOffset = 0
        $script:scrollActivated = $false
        $script:previewData = @()
        $script:previewIndex = -1
        Build-LauncherPhase1

        $size = Get-LauncherSize
        $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)

        # Multi-monitor: center on screen where cursor is
        $pt = New-Object HotkeyInterop+POINT
        [HotkeyInterop]::GetCursorPos([ref]$pt) | Out-Null
        $hMon = [HotkeyInterop]::MonitorFromPoint($pt, [HotkeyInterop]::MONITOR_DEFAULTTONEAREST)
        $mi = New-Object HotkeyInterop+MONITORINFO
        $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
        [HotkeyInterop]::GetMonitorInfo($hMon, [ref]$mi) | Out-Null
        $workArea = $mi.rcWork
        $cx = [int](($workArea.Left + $workArea.Right) / 2 - $size.Width / 2)
        $cy = [int](($workArea.Top + $workArea.Bottom) / 2 - $size.Height / 2)
        $script:launcherForm.Location = New-Object System.Drawing.Point($cx, $cy)

        # Show immediately with cached statuses, THEN refresh git in background
        $script:launcherForm.Show()
        $script:launcherForm.Activate()
        $script:launcherForm.Invalidate()

        # Now refresh git statuses (will repaint when done via timer)
        $script:gitRefreshPending = $true
        Start-GitStatusRefresh
    } catch {
        Write-DockLog "error" @{ function = "Show-Launcher"; message = $_.Exception.Message }
    }
    $sw.Stop()
    Write-DockLog "launcher_shown" @{ duration_ms = $sw.ElapsedMilliseconds; phase = 1 }
}

function Hide-Launcher {
    if ($script:launcherForm -and $script:launcherForm.Visible) {
        $script:launcherForm.Hide()
        $script:filterText = ""
        $script:previewData = @()
        $script:previewIndex = -1
    }
}

# ============================================================
# Build Phase Items
# ============================================================
function Build-LauncherPhase1 {
    $script:currentPhase = 1
    $script:scrollOffset = 0
    $script:scrollActivated = $false
    $script:launcherItems = @()

    # Project Manager item (modular — controlled by config)
    $pmEnabled = $true
    if ($script:config.PSObject.Properties['project_manager'] -and
        $script:config.project_manager.PSObject.Properties['enabled']) {
        $pmEnabled = $script:config.project_manager.enabled
    }
    if ($pmEnabled) {
        $script:launcherItems += @{
            Label       = "Project Manager"
            AccelKey    = "M"
            GitStatus   = ""
            IssueBadge  = ""
            Type        = "manager"
            Index       = -1
            isPinned    = $false
            isDiscovered = $false
            isSeparatorAfter = $true
        }
    }

    for ($i = 0; $i -lt $script:allProjects.Count; $i++) {
        $proj = $script:allProjects[$i]
        $accelKey = $script:launcherAccelMap[$proj.name]
        $gitStatus = $script:launcherGitStatuses[$proj.name]
        # Show loading indicator when git status is pending
        if (-not $gitStatus -and $script:gitRefreshPending) { $gitStatus = "(...)" }
        # Feature 3: issue badge
        $issueBadge = ""
        $ghRepo = $script:projectGhRepos[$proj.path]
        if ($ghRepo) {
            $ic = Get-IssueCount $ghRepo
            if ($ic -gt 0) { $issueBadge = "$([char]0x26A0)$ic" }
        }
        $projLabel = $proj.name
        $maxNameLen = 32
        if ($gitStatus -or $issueBadge) { $maxNameLen = 26 }
        if ($projLabel.Length -gt $maxNameLen) { $projLabel = $projLabel.Substring(0, $maxNameLen - 3) + "..." }
        $script:launcherItems += @{
            Label       = $projLabel
            AccelKey    = $accelKey
            GitStatus   = $gitStatus
            IssueBadge  = $issueBadge
            Type        = "project"
            Index       = $i
            isPinned    = $proj.isPinned
            isDiscovered = $proj.isDiscovered
        }
    }
    # Empty state: show guidance if no projects
    $hasProjects = ($script:launcherItems | Where-Object { $_.Type -eq "project" }).Count -gt 0
    if (-not $hasProjects) {
        $script:launcherItems += @{
            Label       = "No projects found"
            AccelKey    = ""
            GitStatus   = ""
            IssueBadge  = ""
            Type        = "info"
            Index       = -1
            isPinned    = $false
            isDiscovered = $false
        }
        $script:launcherItems += @{
            Label       = "Use Claude Code to create sessions"
            AccelKey    = ""
            GitStatus   = ""
            IssueBadge  = ""
            Type        = "info"
            Index       = -1
            isPinned    = $false
            isDiscovered = $false
        }
    }
    Get-FilteredItems
    # Default highlight to first actual project (skip manager item)
    $script:highlightIndex = 0
    if ($script:launcherItems.Count -gt 1 -and $script:launcherItems[0].Type -eq "manager") {
        $script:highlightIndex = 1
    }
    $size = Get-LauncherSize
    $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
}

function Build-LauncherPhase2($projectIndex) {
    $script:currentPhase = 2
    $script:selectedProjectIndex = $projectIndex
    $proj = $script:allProjects[$projectIndex]
    $script:launcherSessions = @(Get-RecentSessions $proj.path 5)
    $script:selectedGhRepo = $script:projectGhRepos[$proj.path]
    $script:launcherItems = @()
    $script:filterText = ""

    # New Session
    $script:launcherItems += @{ Label = "New Session"; AccelKey = "N"; Type = "new"; StatsLabel = "" }
    # Continue Last
    $script:launcherItems += @{ Label = "Continue Last"; AccelKey = "C"; Type = "continue"; StatsLabel = "" }

    # Feature 3: Issues action
    if ($script:selectedGhRepo) {
        $ic = Get-IssueCount $script:selectedGhRepo
        $issueLabel = "Issues"
        if ($ic -gt 0) { $issueLabel = "Issues ($ic)" }
        $script:launcherItems += @{ Label = $issueLabel; AccelKey = "I"; Type = "issues"; StatsLabel = "" }
    }

    # Recent sessions (truncate label to avoid overlapping stats)
    $num = 1
    foreach ($sess in $script:launcherSessions) {
        $rawLabel = "$($sess.DateLabel) - $($sess.Summary)"
        $maxLabelLen = 38
        if ($sess.StatsLabel) { $maxLabelLen = 30 }
        if ($rawLabel.Length -gt $maxLabelLen) { $rawLabel = $rawLabel.Substring(0, $maxLabelLen - 3) + "..." }
        $script:launcherItems += @{
            Label      = $rawLabel
            AccelKey   = "$num"
            Type       = "session"
            SessionId  = $sess.Id
            StatsLabel = $sess.StatsLabel
            FilePath   = $sess.FilePath
        }
        $num++
        if ($num -gt 5) { break }
    }
    # Back item for mouse users
    $script:launcherItems += @{ Label = "$([char]0x2190) Back"; AccelKey = ""; Type = "back"; StatsLabel = "" }
    $script:highlightIndex = 0
    $script:previewData = @()
    $script:previewIndex = -1
    $size = Get-LauncherSize
    $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
}

# Project Manager Phase 2
function Build-ManagerPhase2 {
    $script:currentPhase = 2
    $script:selectedProjectIndex = -1  # sentinel: PM mode
    $script:launcherItems = @()
    $script:filterText = ""

    # New Session (generates fresh inventory)
    $script:launcherItems += @{ Label = "New Session"; AccelKey = "N"; Type = "pm-new"; StatsLabel = "" }
    # Continue Last
    $script:launcherItems += @{ Label = "Continue Last"; AccelKey = "C"; Type = "pm-continue"; StatsLabel = "" }

    # Recent PM sessions
    $pmDir = Join-Path $env:USERPROFILE ".claude\project-manager"
    $pmSessions = @(Get-RecentSessions $pmDir 5)
    $num = 1
    foreach ($sess in $pmSessions) {
        $rawLabel = "$($sess.DateLabel) - $($sess.Summary)"
        $maxLabelLen = 38
        if ($sess.StatsLabel) { $maxLabelLen = 30 }
        if ($rawLabel.Length -gt $maxLabelLen) { $rawLabel = $rawLabel.Substring(0, $maxLabelLen - 3) + "..." }
        $script:launcherItems += @{
            Label      = $rawLabel
            AccelKey   = "$num"
            Type       = "pm-session"
            SessionId  = $sess.Id
            StatsLabel = $sess.StatsLabel
            FilePath   = $sess.FilePath
        }
        $num++
        if ($num -gt 5) { break }
    }
    # Back item
    $script:launcherItems += @{ Label = "$([char]0x2190) Back"; AccelKey = ""; Type = "back"; StatsLabel = "" }
    $script:highlightIndex = 0
    $script:previewData = @()
    $script:previewIndex = -1
    $size = Get-LauncherSize
    $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
}

# Feature 3: Phase 3 - Issue list
function Build-LauncherPhase3($ghRepo) {
    $script:currentPhase = 3
    $script:launcherItems = @()
    $script:filterText = ""

    if ($script:issueCache.ContainsKey($ghRepo)) {
        $issues = $script:issueCache[$ghRepo].Issues
        $num = 1
        foreach ($issue in $issues) {
            $accel = if ($num -le 9) { "$num" } else { "" }
            $labelText = "#$($issue.number) $($issue.title)"
            if ($labelText.Length -gt 55) { $labelText = $labelText.Substring(0, 52) + "..." }
            $labelsText = ""
            if ($issue.PSObject.Properties['labels'] -and $issue.labels) {
                $labelNames = $issue.labels | ForEach-Object { $_.name }
                $labelsText = ($labelNames -join ", ")
            }
            $script:launcherItems += @{
                Label       = $labelText
                AccelKey    = $accel
                Type        = "issue"
                IssueNumber = $issue.number
                IssueTitle  = $issue.title
                LabelsText  = $labelsText
            }
            $num++
            if ($num -gt 20) { break }
        }
    }

    if ($script:launcherItems.Count -eq 0) {
        $script:launcherItems += @{ Label = "No open issues"; AccelKey = ""; Type = "info"; IssueNumber = 0; IssueTitle = ""; LabelsText = "" }
    }

    # Back item for mouse users
    $script:launcherItems += @{ Label = "$([char]0x2190) Back"; AccelKey = ""; Type = "back"; IssueNumber = 0; IssueTitle = ""; LabelsText = "" }
    $script:highlightIndex = 0
    $size = Get-LauncherSize
    $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
}

# ============================================================
# Invoke Selection
# ============================================================
function Invoke-LauncherSelection($index) {
    $visibleItems = Get-ViewportItems
    if ($index -lt 0 -or $index -ge $visibleItems.Count) { return }
    $item = $visibleItems[$index]

    # Handle back navigation from any phase
    if ($item.Type -eq "back") {
        if ($script:currentPhase -eq 3) {
            Build-LauncherPhase2 $script:selectedProjectIndex
        } elseif ($script:currentPhase -eq 2) {
            Build-LauncherPhase1
        }
        $script:launcherForm.Invalidate()
        return
    }

    if ($script:currentPhase -eq 1) {
        if ($item.Type -eq "info") { return }
        if ($item.Type -eq "manager") {
            Build-ManagerPhase2
            $script:launcherForm.Invalidate()
            return
        }
        Write-DockLog "project_selected" @{ name = $item.Label; index = $item.Index }
        Build-LauncherPhase2 $item.Index
        $script:launcherForm.Invalidate()
    } elseif ($script:currentPhase -eq 2 -and $script:selectedProjectIndex -eq -1) {
        # Project Manager Phase 2
        if ($item.Type -eq "back") {
            Build-LauncherPhase1
            $script:launcherForm.Invalidate()
            return
        }
        Hide-Launcher
        $pmDir = Join-Path $env:USERPROFILE ".claude\project-manager"
        if (-not (Test-Path $pmDir)) {
            New-Item -Path $pmDir -ItemType Directory -Force | Out-Null
        }
        switch ($item.Type) {
            "pm-new" {
                Write-DockLog "action_launched" @{ type = "pm-new" }
                Show-LaunchToast "Project Manager" "New Session"
                Launch-ProjectManager
            }
            "pm-continue" {
                Write-DockLog "action_launched" @{ type = "pm-continue" }
                Show-LaunchToast "Project Manager" "Continue"
                Start-ClaudeCmd "claude --continue" $pmDir
            }
            "pm-session" {
                Write-DockLog "action_launched" @{ type = "pm-resume"; sessionId = $item.SessionId }
                Show-LaunchToast "Project Manager" "Resume"
                Launch-ProjectResume $pmDir $item.SessionId
            }
        }
    } elseif ($script:currentPhase -eq 2) {
        $proj = $script:allProjects[$script:selectedProjectIndex]
        if ($item.Type -eq "issues") {
            if ($script:selectedGhRepo) {
                Build-LauncherPhase3 $script:selectedGhRepo
                $script:launcherForm.Invalidate()
            }
            return
        }
        Hide-Launcher
        switch ($item.Type) {
            "new" {
                Write-DockLog "action_launched" @{ type = "new"; project = $proj.name }
                Show-LaunchToast $proj.name "New Session"
                Launch-Project $proj.path
            }
            "continue" {
                Write-DockLog "action_launched" @{ type = "continue"; project = $proj.name }
                Show-LaunchToast $proj.name "Continue"
                Launch-ProjectContinue $proj.path
            }
            "session" {
                Write-DockLog "action_launched" @{ type = "resume"; project = $proj.name; sessionId = $item.SessionId }
                Show-LaunchToast $proj.name "Resume: $($item.Label)"
                Launch-ProjectResume $proj.path $item.SessionId
            }
        }
    } elseif ($script:currentPhase -eq 3) {
        if ($item.Type -eq "info") { return }
        $proj = $script:allProjects[$script:selectedProjectIndex]
        Hide-Launcher
        Write-DockLog "action_launched" @{ type = "issue_fix"; project = $proj.name; issue = $item.IssueNumber }
        Show-LaunchToast $proj.name "Fix Issue #$($item.IssueNumber)"
        Launch-IssueFixSession $proj.path $script:selectedGhRepo $item.IssueNumber $item.IssueTitle
    }
}

# ============================================================
# Feature 7: Visual Launch Feedback (Toast)
# ============================================================
function Show-LaunchToast($projectName, $action) {
    try {
        # Close any previous toast still lingering
        if ($script:activeToast -and -not $script:activeToast.IsDisposed) {
            try { $script:activeToast.Close(); $script:activeToast.Dispose() } catch { }
        }
        if ($script:activeToastTimer) {
            try { $script:activeToastTimer.Stop(); $script:activeToastTimer.Dispose() } catch { }
        }

        # Store text in $script: so PS 5.1 delegate closures can see it
        $script:toastText = $projectName

        $script:activeToast = New-Object System.Windows.Forms.Form
        $script:activeToast.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $script:activeToast.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $script:activeToast.TopMost = $true
        $script:activeToast.ShowInTaskbar = $false
        $script:activeToast.Size = New-Object System.Drawing.Size(300, 48)
        $script:activeToast.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
        $script:activeToast.Opacity = 0.95

        # Win11 rounded corners
        try {
            $cornerPref = [HotkeyInterop]::DWMWCP_ROUND
            [HotkeyInterop]::DwmSetWindowAttribute(
                $script:activeToast.Handle,
                [HotkeyInterop]::DWMWA_WINDOW_CORNER_PREFERENCE,
                [ref]$cornerPref, 4) | Out-Null
        } catch { }

        # Position near where launcher was
        if ($script:launcherForm) {
            $lx = $script:launcherForm.Location.X + ($script:launcherForm.Width / 2) - 150
            $ly = $script:launcherForm.Location.Y + ($script:launcherForm.Height / 2) - 24
            $script:activeToast.Location = New-Object System.Drawing.Point([int]$lx, [int]$ly)
        }

        $script:activeToast.Add_Paint({
            param($sender, $e)
            try {
                $g = $e.Graphics
                $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
                $w = $sender.ClientSize.Width
                $h = $sender.ClientSize.Height

                # Border
                $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(48, 48, 48), 1)
                $g.DrawRectangle($borderPen, 0, 0, $w - 1, $h - 1)
                $borderPen.Dispose()

                # Icon (24x24, vertically centered)
                $textX = 14
                if ($script:iconBitmap) {
                    $g.DrawImage($script:iconBitmap, 10, [int]($h / 2 - 12), 24, 24)
                    $textX = 40
                }

                # Text: "Launching " in white, "ProjectName..." in amber
                $f = New-Object System.Drawing.Font("Segoe UI", 9.5)
                $amberBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(232, 118, 50))
                $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(232, 237, 245))
                $prefix = "Launching "
                $g.DrawString($prefix, $f, $whiteBrush, $textX, 13)
                $prefixWidth = $g.MeasureString($prefix, $f).Width - 4
                $nameStr = "$($script:toastText)..."
                $g.DrawString($nameStr, $f, $amberBrush, $textX + $prefixWidth, 13)

                # Version label (right-aligned, dim)
                $vf = New-Object System.Drawing.Font("Segoe UI", 7)
                $dimBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 90, 90))
                $verStr = "v$($script:CONFIG_VERSION)"
                $verSize = $g.MeasureString($verStr, $vf)
                $g.DrawString($verStr, $vf, $dimBrush, $w - $verSize.Width - 6, $h - $verSize.Height - 4)
                $vf.Dispose(); $dimBrush.Dispose()

                $f.Dispose(); $amberBrush.Dispose(); $whiteBrush.Dispose()
            } catch { }
        })

        # Auto-close after 1.5s
        $script:activeToastTimer = New-Object System.Windows.Forms.Timer
        $script:activeToastTimer.Interval = 1500
        $script:activeToastTimer.Add_Tick({
            try {
                $script:activeToastTimer.Stop()
                $script:activeToastTimer.Dispose()
                $script:activeToastTimer = $null
                if ($script:activeToast -and -not $script:activeToast.IsDisposed) {
                    $script:activeToast.Close()
                    $script:activeToast.Dispose()
                }
                $script:activeToast = $null
            } catch { }
        })

        $script:activeToastTimer.Start()
        $script:activeToast.Show()
    } catch {
        Write-DockLog "error" @{ function = "Show-LaunchToast"; message = $_.Exception.Message }
    }
}

# ============================================================
# Initialize Launcher Form
# ============================================================
function Initialize-LauncherForm {
    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.TopMost = $true
    $form.ShowInTaskbar = $false
    $form.KeyPreview = $true
    $form.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
    $form.Size = New-Object System.Drawing.Size(420, 300)
    # Double buffering via reflection
    $setStyleMethod = $form.GetType().GetMethod("SetStyle",
        [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
    $styles = [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
              [System.Windows.Forms.ControlStyles]::UserPaint -bor
              [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer
    $setStyleMethod.Invoke($form, @($styles, $true))

    # Win11 rounded corners
    try {
        $cornerPref = [HotkeyInterop]::DWMWCP_ROUND
        [HotkeyInterop]::DwmSetWindowAttribute(
            $form.Handle,
            [HotkeyInterop]::DWMWA_WINDOW_CORNER_PREFERENCE,
            [ref]$cornerPref, 4) | Out-Null
    } catch { }

    # --- Paint handler ---
    $form.Add_Paint({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            $g = $e.Graphics
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
            $w = $sender.ClientSize.Width
            $h = $sender.ClientSize.Height

            # Colors — CLD CTRL brand palette
            $bgColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
            $borderColor = [System.Drawing.Color]::FromArgb(48, 48, 48)
            $highlightBg = [System.Drawing.Color]::FromArgb(35, 95, 40)
            $amberColor = [System.Drawing.Color]::FromArgb(232, 118, 50)   # #e87632 CLD orange
            $whiteColor = [System.Drawing.Color]::FromArgb(232, 237, 245)  # #e8edf5 CTRL white
            $greenColor = [System.Drawing.Color]::FromArgb(45, 212, 191)   # #2dd4bf teal success
            $yellowColor = [System.Drawing.Color]::FromArgb(245, 158, 11)  # #f59e0b amber warning
            $blueColor = [System.Drawing.Color]::FromArgb(56, 140, 255)    # #388cff secondary blue
            $dimColor = [System.Drawing.Color]::FromArgb(140, 140, 140)
            $sepColor = [System.Drawing.Color]::FromArgb(48, 48, 48)
            $dimDiscoveredColor = [System.Drawing.Color]::FromArgb(150, 150, 150)

            # Monospace fonts — prefer IBM Plex Mono, fallback to Consolas
            $monoFamily = "Consolas"
            $installedFonts = [System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }
            if ($installedFonts -contains "IBM Plex Mono") { $monoFamily = "IBM Plex Mono" }
            $headerFont = New-Object System.Drawing.Font($monoFamily, 10, [System.Drawing.FontStyle]::Bold)
            $itemFont = New-Object System.Drawing.Font($monoFamily, 10)
            $accelFont = New-Object System.Drawing.Font($monoFamily, 10, [System.Drawing.FontStyle]::Bold)
            $statusFont = New-Object System.Drawing.Font($monoFamily, 8)
            $footerFont = New-Object System.Drawing.Font($monoFamily, 8)
            $filterFont = New-Object System.Drawing.Font($monoFamily, 9)
            $previewFont = New-Object System.Drawing.Font($monoFamily, 8, [System.Drawing.FontStyle]::Italic)
            $labelFont = New-Object System.Drawing.Font($monoFamily, 7.5)

            # Brushes / Pens
            $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
            $borderPen = New-Object System.Drawing.Pen($borderColor, 1)
            $highlightBrush = New-Object System.Drawing.SolidBrush($highlightBg)
            $amberBrush = New-Object System.Drawing.SolidBrush($amberColor)
            $whiteBrush = New-Object System.Drawing.SolidBrush($whiteColor)
            $greenBrush = New-Object System.Drawing.SolidBrush($greenColor)
            $yellowBrush = New-Object System.Drawing.SolidBrush($yellowColor)
            $blueBrush = New-Object System.Drawing.SolidBrush($blueColor)
            $dimBrush = New-Object System.Drawing.SolidBrush($dimColor)
            $sepPen = New-Object System.Drawing.Pen($sepColor, 1)
            $dimDiscBrush = New-Object System.Drawing.SolidBrush($dimDiscoveredColor)

            $check = [char]0x2713
            $bullet = [char]0x25CF
            $upArrow = [char]0x2191

            # Background + Border
            $g.FillRectangle($bgBrush, 0, 0, $w, $h)
            $g.DrawRectangle($borderPen, 0, 0, $w - 1, $h - 1)

            $y = 8

            # Header with icon
            $headerTextX = 10
            if ($script:iconBitmap) {
                $g.DrawImage($script:iconBitmap, 10, $y + 2, 22, 22)
                $headerTextX = 36
            }
            if ($script:currentPhase -eq 1) {
                # Two-tone header: CLD in orange, CTRL in white
                $g.DrawString("CLD", $headerFont, $amberBrush, $headerTextX, $y + 3)
                $cldWidth = $g.MeasureString("CLD ", $headerFont).Width - 4
                $g.DrawString("CTRL", $headerFont, $whiteBrush, $headerTextX + $cldWidth, $y + 3)
            } elseif ($script:currentPhase -eq 2) {
                if ($script:selectedProjectIndex -eq -1) {
                    $g.DrawString("Project Manager", $headerFont, $amberBrush, $headerTextX, $y + 3)
                } else {
                    $proj = $script:allProjects[$script:selectedProjectIndex]
                    $headerText = $proj.name
                    $gs = $script:launcherGitStatuses[$proj.name]
                    if ($gs) { $headerText += "  $gs" }
                    $g.DrawString($headerText, $headerFont, $dimBrush, $headerTextX, $y + 3)
                }
            } elseif ($script:currentPhase -eq 3) {
                $proj = $script:allProjects[$script:selectedProjectIndex]
                $g.DrawString("$($proj.name) > Issues", $headerFont, $dimBrush, $headerTextX, $y + 3)
            }
            $y += 28

            # Feature 6: Filter bar
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0) {
                $filterDisplay = "  / $($script:filterText)"
                $g.DrawString($filterDisplay, $filterFont, $amberBrush, 8, $y)
                $y += 24
            }

            # Separator
            $g.DrawLine($sepPen, 8, $y, $w - 8, $y)
            $y += 5

            # Items
            $visibleItems = Get-ViewportItems
            $allItemsForScroll = Get-VisibleItems
            $itemH = 30
            $sessionSepDrawn = $false
            $discoveredSepDrawn = $false

            # Scroll indicator: "N more above"
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0 -and $script:scrollOffset -gt 0) {
                $aboveText = "$([char]0x25B2) $($script:scrollOffset) more above"
                $g.DrawString($aboveText, $statusFont, $dimBrush, 48, $y)
                $y += 14
            }

            for ($i = 0; $i -lt $visibleItems.Count; $i++) {
                $item = $visibleItems[$i]

                # Thin separator after Project Manager item
                if ($script:currentPhase -eq 1 -and $i -gt 0 -and $visibleItems[$i - 1].ContainsKey('isSeparatorAfter') -and $visibleItems[$i - 1].isSeparatorAfter) {
                    $g.DrawLine($sepPen, 8, $y, $w - 8, $y)
                    $y += 4
                }

                # Feature 2: separator between pinned and discovered (Phase 1)
                if ($script:currentPhase -eq 1 -and $item.isDiscovered -and -not $discoveredSepDrawn) {
                    $g.DrawLine($sepPen, 8, $y, $w - 8, $y)
                    $y += 2
                    $g.DrawString("  Discovered", $statusFont, $dimDiscBrush, 8, $y)
                    $y += 16
                    $discoveredSepDrawn = $true
                }

                # Separator before sessions in phase 2
                if ($script:currentPhase -eq 2 -and ($item.Type -eq "session" -or $item.Type -eq "pm-session") -and -not $sessionSepDrawn) {
                    $g.DrawLine($sepPen, 8, $y, $w - 8, $y)
                    $y += 9
                    $sessionSepDrawn = $true
                }

                # Highlight background
                if ($i -eq $script:highlightIndex) {
                    $g.FillRectangle($highlightBrush, 4, $y, $w - 8, $itemH)
                }

                # Cursor indicator
                $cursorX = 10
                if ($i -eq $script:highlightIndex) {
                    $g.DrawString(">", $accelFont, $amberBrush, $cursorX, $y + 4)
                }

                # Accelerator key
                $accelX = 24
                if ($item.AccelKey) {
                    $g.DrawString($item.AccelKey, $accelFont, $amberBrush, $accelX, $y + 4)
                }

                # Item text
                $textX = 48
                $textBrush2 = $whiteBrush
                if ($script:currentPhase -eq 1) {
                    if ($item.Type -eq "manager") {
                        $textBrush2 = $amberBrush
                    } elseif ($item.Type -eq "info") {
                        $textBrush2 = $dimBrush
                    } elseif ($item.isDiscovered) {
                        $textBrush2 = $dimDiscBrush
                    } else {
                        $gs = $item.GitStatus
                        if ($gs) {
                            # Use white on green highlight to avoid green-on-green contrast issue
                            if ($gs.Contains($check)) {
                                $textBrush2 = if ($i -eq $script:highlightIndex) { $whiteBrush } else { $greenBrush }
                            }
                            elseif ($gs.Contains($bullet) -or $gs.Contains($upArrow)) { $textBrush2 = $yellowBrush }
                        }
                    }
                } elseif ($item.Type -eq "back") {
                    $textBrush2 = $dimBrush
                } elseif ($item.Type -eq "continue") {
                    $textBrush2 = $blueBrush
                } elseif ($item.Type -eq "session") {
                    $textBrush2 = $dimBrush
                } elseif ($item.Type -eq "issues") {
                    $textBrush2 = $yellowBrush
                } elseif ($item.Type -eq "issue") {
                    $textBrush2 = $whiteBrush
                } elseif ($item.Type -eq "info") {
                    $textBrush2 = $dimBrush
                }

                # Feature 6: highlight matching chars in filter mode
                if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0 -and $item.Type -eq "project") {
                    # Draw label with matching substring highlighted
                    $label = $item.Label
                    $filterLower = $script:filterText.ToLower()
                    $matchIdx = $label.ToLower().IndexOf($filterLower)
                    if ($matchIdx -ge 0) {
                        $before = $label.Substring(0, $matchIdx)
                        $match = $label.Substring($matchIdx, $script:filterText.Length)
                        $after = $label.Substring($matchIdx + $script:filterText.Length)
                        $cx2 = $textX
                        if ($before.Length -gt 0) {
                            $g.DrawString($before, $itemFont, $textBrush2, $cx2, $y + 4)
                            $cx2 += $g.MeasureString($before, $itemFont).Width - 4
                        }
                        $g.DrawString($match, $accelFont, $amberBrush, $cx2, $y + 4)
                        $cx2 += $g.MeasureString($match, $accelFont).Width - 4
                        if ($after.Length -gt 0) {
                            $g.DrawString($after, $itemFont, $textBrush2, $cx2, $y + 4)
                        }
                    } else {
                        $g.DrawString($item.Label, $itemFont, $textBrush2, $textX, $y + 4)
                    }
                } else {
                    $g.DrawString($item.Label, $itemFont, $textBrush2, $textX, $y + 4)
                }

                # Right-aligned elements
                $rightX = $w - 12

                # Feature 3: Issue badge in Phase 1
                if ($script:currentPhase -eq 1 -and $item.PSObject -eq $null -and $item.IssueBadge) {
                    # IssueBadge is a hashtable key
                }
                if ($script:currentPhase -eq 1 -and $item.ContainsKey('IssueBadge') -and $item.IssueBadge) {
                    $badgeSize = $g.MeasureString($item.IssueBadge, $statusFont)
                    $badgeX = $rightX - $badgeSize.Width - 4
                    $g.DrawString($item.IssueBadge, $statusFont, $amberBrush, $badgeX, $y + 7)
                    $rightX = $badgeX - 4
                }

                # Git status (right-aligned) in phase 1
                if ($script:currentPhase -eq 1 -and $item.ContainsKey('GitStatus') -and $item.GitStatus) {
                    $statusSize = $g.MeasureString($item.GitStatus, $statusFont)
                    $statusX = $rightX - $statusSize.Width
                    $statusBrush2 = $dimBrush
                    if ($item.GitStatus.Contains($check)) { $statusBrush2 = $greenBrush }
                    elseif ($item.GitStatus.Contains($bullet) -or $item.GitStatus.Contains($upArrow)) { $statusBrush2 = $yellowBrush }
                    $g.DrawString($item.GitStatus, $statusFont, $statusBrush2, $statusX, $y + 7)
                }

                # Feature 1: Stats right-aligned on session rows
                if ($script:currentPhase -eq 2 -and $item.ContainsKey('StatsLabel') -and $item.StatsLabel) {
                    $statsSize = $g.MeasureString($item.StatsLabel, $statusFont)
                    $statsX = $w - $statsSize.Width - 12
                    $g.DrawString($item.StatsLabel, $statusFont, $dimBrush, $statsX, $y + 7)
                }

                # Feature 3: Labels text on issue rows in Phase 3
                if ($script:currentPhase -eq 3 -and $item.ContainsKey('LabelsText') -and $item.LabelsText) {
                    $lblSize = $g.MeasureString($item.LabelsText, $labelFont)
                    $lblX = $w - $lblSize.Width - 12
                    $g.DrawString($item.LabelsText, $labelFont, $dimBrush, $lblX, $y + 8)
                }

                $y += $itemH

                # Feature 8: Session preview (clipped to form width)
                if ($script:currentPhase -eq 2 -and $i -eq $script:previewIndex -and $script:previewData.Count -gt 0) {
                    $clipRect = New-Object System.Drawing.RectangleF($textX, $y, ($w - $textX - 12), ($script:previewData.Count * 16 + 4))
                    $g.SetClip($clipRect)
                    foreach ($previewLine in $script:previewData) {
                        $g.DrawString("    $previewLine", $previewFont, $dimBrush, $textX, $y)
                        $y += 16
                    }
                    $g.ResetClip()
                    $y += 4
                }
            }

            # Scroll indicator: "N more below"
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0) {
                $maxVisible = if ($script:scrollActivated) { $script:MAX_VIEWPORT_ITEMS } else { $script:INITIAL_VISIBLE_COUNT }
                $belowCount = $allItemsForScroll.Count - $script:scrollOffset - $maxVisible
                if ($belowCount -gt 0) {
                    $belowText = "$([char]0x25BC) $belowCount more below"
                    $g.DrawString($belowText, $statusFont, $dimBrush, 48, $y)
                    $y += 14
                }
            }

            # Footer separator
            $y += 2
            $g.DrawLine($sepPen, 8, $y, $w - 8, $y)
            $y += 6

            # Footer hints
            if ($script:currentPhase -eq 1) {
                $footerText = "  $([char]0x2191)$([char]0x2193) scroll  type to filter  right-click pin  H hide  esc close"
                $g.DrawString($footerText, $footerFont, $dimBrush, 8, $y)
                # Feature 9: update indicator
                if ($script:updateAvailable) {
                    $updateText = "$([char]0x2B06) Update available"
                    $upSize = $g.MeasureString($updateText, $footerFont)
                    $g.DrawString($updateText, $footerFont, $amberBrush, $w - $upSize.Width - 12, $y)
                }
            } elseif ($script:currentPhase -eq 2) {
                $footerText = "  $([char]0x2191)$([char]0x2193) navigate   esc back"
                $g.DrawString($footerText, $footerFont, $dimBrush, 8, $y)
            } elseif ($script:currentPhase -eq 3) {
                $footerText = "  $([char]0x2191)$([char]0x2193) navigate   enter fix issue   esc back"
                $g.DrawString($footerText, $footerFont, $dimBrush, 8, $y)
            }

        } catch {
            Write-DockLog "error" @{ function = "Paint"; message = $_.Exception.Message }
        } finally {
            # Dispose GDI objects even if paint handler threw (prevents GDI handle exhaustion)
            try {
                if ($headerFont) { $headerFont.Dispose() }; if ($itemFont) { $itemFont.Dispose() }
                if ($accelFont) { $accelFont.Dispose() }; if ($statusFont) { $statusFont.Dispose() }
                if ($footerFont) { $footerFont.Dispose() }; if ($filterFont) { $filterFont.Dispose() }
                if ($previewFont) { $previewFont.Dispose() }; if ($labelFont) { $labelFont.Dispose() }
                if ($bgBrush) { $bgBrush.Dispose() }; if ($highlightBrush) { $highlightBrush.Dispose() }
                if ($amberBrush) { $amberBrush.Dispose() }; if ($whiteBrush) { $whiteBrush.Dispose() }
                if ($greenBrush) { $greenBrush.Dispose() }; if ($yellowBrush) { $yellowBrush.Dispose() }
                if ($blueBrush) { $blueBrush.Dispose() }; if ($dimBrush) { $dimBrush.Dispose() }
                if ($dimDiscBrush) { $dimDiscBrush.Dispose() }
                if ($borderPen) { $borderPen.Dispose() }; if ($sepPen) { $sepPen.Dispose() }
            } catch { }
        }
    })

    # --- Key handling ---
    $form.Add_KeyDown({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            $key = $e.KeyCode

            # Ctrl+Up toggles closed
            if ($key -eq [System.Windows.Forms.Keys]::Up -and $e.Control) {
                Hide-Launcher
                $e.Handled = $true
                $e.SuppressKeyPress = $true
                return
            }

            $visibleItems = Get-VisibleItems

            switch ($key) {
                ([System.Windows.Forms.Keys]::Escape) {
                    # Feature 6: clear filter first, then navigate back
                    if ($script:filterText.Length -gt 0) {
                        $script:filterText = ""
                        Get-FilteredItems
                        $script:highlightIndex = 0
                        $sender.Invalidate()
                    } elseif ($script:currentPhase -eq 3) {
                        Build-LauncherPhase2 $script:selectedProjectIndex
                        $sender.Invalidate()
                    } elseif ($script:currentPhase -eq 2) {
                        Build-LauncherPhase1
                        $sender.Invalidate()
                    } else {
                        Hide-Launcher
                    }
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Back) {
                    # Feature 6: remove last filter char
                    if ($script:filterText.Length -gt 0) {
                        $script:filterText = $script:filterText.Substring(0, $script:filterText.Length - 1)
                        Get-FilteredItems
                        $script:highlightIndex = 0
                        $size = Get-LauncherSize
                        $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                        $sender.Invalidate()
                    } elseif ($script:currentPhase -eq 3) {
                        Build-LauncherPhase2 $script:selectedProjectIndex
                        $sender.Invalidate()
                    } elseif ($script:currentPhase -eq 2) {
                        Build-LauncherPhase1
                        $sender.Invalidate()
                    } else {
                        Hide-Launcher
                    }
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Up) {
                    if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0) {
                        # Scrollable Phase 1
                        $viewportItems = Get-ViewportItems
                        if ($script:highlightIndex -gt 0) {
                            $script:highlightIndex--
                        } elseif ($script:scrollOffset -gt 0) {
                            $script:scrollOffset--
                            $size = Get-LauncherSize
                            $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                        }
                    } else {
                        if ($script:highlightIndex -gt 0) { $script:highlightIndex-- }
                    }
                    if ($script:hoverTimer) { $script:hoverTimer.Stop(); $script:hoverTimer.Start() }
                    $script:previewData = @()
                    $script:previewIndex = -1
                    $sender.Invalidate()
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Down) {
                    if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0) {
                        # Scrollable Phase 1
                        $viewportItems = Get-ViewportItems
                        $allItems = Get-VisibleItems
                        $maxVisible = if ($script:scrollActivated) { $script:MAX_VIEWPORT_ITEMS } else { $script:INITIAL_VISIBLE_COUNT }
                        if ($script:highlightIndex -lt ($viewportItems.Count - 1)) {
                            $script:highlightIndex++
                        } elseif (($script:scrollOffset + $maxVisible) -lt $allItems.Count) {
                            $script:scrollOffset++
                            $script:scrollActivated = $true
                            $size = Get-LauncherSize
                            $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                        }
                    } else {
                        if ($script:highlightIndex -lt ($visibleItems.Count - 1)) { $script:highlightIndex++ }
                    }
                    if ($script:hoverTimer) { $script:hoverTimer.Stop(); $script:hoverTimer.Start() }
                    $script:previewData = @()
                    $script:previewIndex = -1
                    $sender.Invalidate()
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Return) {
                    Invoke-LauncherSelection $script:highlightIndex
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Right) {
                    Invoke-LauncherSelection $script:highlightIndex
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Left) {
                    if ($script:currentPhase -eq 3) {
                        Build-LauncherPhase2 $script:selectedProjectIndex
                        $sender.Invalidate()
                    } elseif ($script:currentPhase -eq 2) {
                        Build-LauncherPhase1
                        $sender.Invalidate()
                    } else {
                        Hide-Launcher
                    }
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::Home) {
                    $script:scrollOffset = 0
                    $script:highlightIndex = 0
                    $size = Get-LauncherSize
                    $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                    $sender.Invalidate()
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
                ([System.Windows.Forms.Keys]::End) {
                    $allItems = Get-VisibleItems
                    $maxVisible = $script:MAX_VIEWPORT_ITEMS
                    if ($allItems.Count -gt $maxVisible) {
                        $script:scrollOffset = $allItems.Count - $maxVisible
                        $script:scrollActivated = $true
                        $script:highlightIndex = $maxVisible - 1
                    } else {
                        $script:highlightIndex = [Math]::Max(0, $allItems.Count - 1)
                    }
                    $size = Get-LauncherSize
                    $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                    $sender.Invalidate()
                    $e.Handled = $true
                    $e.SuppressKeyPress = $true
                }
            }
        } catch {
            Write-DockLog "error" @{ function = "KeyDown"; message = $_.Exception.Message }
        }
    })

    $form.Add_KeyPress({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            $ch = [char]::ToUpper($e.KeyChar)
            $visibleItems = Get-ViewportItems

            # Feature 2: H key to toggle hide in Phase 1
            if ($script:currentPhase -eq 1 -and $ch -eq 'H' -and $script:filterText.Length -eq 0) {
                $highlightedItem = $visibleItems[$script:highlightIndex]
                if ($highlightedItem -and $highlightedItem.Type -eq "project") {
                    $proj = $script:allProjects[$highlightedItem.Index]
                    if ($proj.isDiscovered) {
                        Toggle-HiddenProject $proj.path
                        Build-ProjectList
                        $script:launcherAccelMap = Get-AcceleratorMap
                        Build-LauncherPhase1
                        if ($script:highlightIndex -ge (Get-ViewportItems).Count) {
                            $script:highlightIndex = [Math]::Max(0, (Get-ViewportItems).Count - 1)
                        }
                        $size = Get-LauncherSize
                        $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                        $sender.Invalidate()
                        $e.Handled = $true
                        return
                    }
                }
            }

            # Feature 9: U key for update
            if ($script:currentPhase -eq 1 -and $ch -eq 'U' -and $script:filterText.Length -eq 0 -and $script:updateAvailable) {
                Start-Process "https://github.com/RyanSeanPhillips/cldctrl/releases"
                $e.Handled = $true
                return
            }

            # Feature 6: If filter is active, all typing goes to filter
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0) {
                if ($e.KeyChar -match '[a-zA-Z0-9 _\-]') {
                    $script:filterText += $e.KeyChar.ToString()
                    Get-FilteredItems
                    $script:highlightIndex = 0
                    # Auto-select if only 1 match
                    $filtered = Get-VisibleItems
                    if ($filtered.Count -eq 1) {
                        # Don't auto-invoke, just highlight
                    }
                    $size = Get-LauncherSize
                    $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                    $sender.Invalidate()
                    $e.Handled = $true
                    return
                }
            }

            # Try accelerator match (only when filter is empty)
            # Search ALL items (not just viewport) so scrolled-off accelerators still work
            if ($script:filterText.Length -eq 0) {
                $allVisItems = Get-VisibleItems
                for ($i = 0; $i -lt $allVisItems.Count; $i++) {
                    if ($allVisItems[$i].AccelKey -eq [string]$ch) {
                        $matchItem = $allVisItems[$i]
                        if ($script:currentPhase -eq 1) {
                            if ($matchItem.Type -eq "manager") {
                                Build-ManagerPhase2
                                $sender.Invalidate()
                            } elseif ($matchItem.Type -eq "project") {
                                Build-LauncherPhase2 $matchItem.Index
                                $sender.Invalidate()
                            }
                        } else {
                            Invoke-LauncherSelection $i
                        }
                        $e.Handled = $true
                        return
                    }
                }
            }

            # Feature 6: Start filtering if no accelerator matched (Phase 1 only)
            if ($script:currentPhase -eq 1 -and $e.KeyChar -match '[a-zA-Z0-9]') {
                $script:filterText += $e.KeyChar.ToString()
                Get-FilteredItems
                $script:highlightIndex = 0
                $size = Get-LauncherSize
                $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                $sender.Invalidate()
                $e.Handled = $true
                return
            }
        } catch {
            Write-DockLog "error" @{ function = "KeyPress"; message = $_.Exception.Message }
        }
    })

    # Ensure form captures mouse wheel by re-focusing on mouse enter
    $form.Add_MouseEnter({
        param($sender, $e)
        try { $sender.Focus() } catch { }
    })

    # Mouse wheel scrolling (Phase 1 only)
    $form.Add_MouseWheel({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            if ($script:currentPhase -ne 1 -or $script:filterText.Length -gt 0) { return }
            $allItems = Get-VisibleItems
            $maxVisible = $script:MAX_VIEWPORT_ITEMS
            if ($allItems.Count -le $maxVisible) { return }

            $scrollDelta = if ($e.Delta -gt 0) { -3 } else { 3 }  # up = negative delta
            $newOffset = $script:scrollOffset + $scrollDelta
            $newOffset = [Math]::Max(0, [Math]::Min($newOffset, $allItems.Count - $maxVisible))
            if ($newOffset -ne $script:scrollOffset) {
                $script:scrollOffset = $newOffset
                $script:scrollActivated = $true
                # Clamp highlight to viewport
                $vpCount = (Get-ViewportItems).Count
                if ($script:highlightIndex -ge $vpCount) {
                    $script:highlightIndex = $vpCount - 1
                }
                $size = Get-LauncherSize
                $sender.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                $sender.Invalidate()
            }
        } catch {
            Write-DockLog "error" @{ function = "MouseWheel"; message = $_.Exception.Message }
        }
    })

    # Mouse hover: move highlight to item under cursor
    $form.Add_MouseMove({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            $mouseY = $e.Y
            $filterBarH = 0
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0) { $filterBarH = 28 }
            $scrollAboveH = 0
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0 -and $script:scrollOffset -gt 0) { $scrollAboveH = 14 }
            $currentY = 8 + 28 + $filterBarH + 5 + $scrollAboveH
            $itemH = 30
            $viewportItems = Get-ViewportItems
            $discoveredSepSeen = $false
            $sessionSepSeen = $false
            $hoverIdx = -1
            for ($vi = 0; $vi -lt $viewportItems.Count; $vi++) {
                $vItem = $viewportItems[$vi]
                if ($script:currentPhase -eq 1) {
                    if ($vi -gt 0 -and $viewportItems[$vi - 1].ContainsKey('isSeparatorAfter') -and $viewportItems[$vi - 1].isSeparatorAfter) {
                        $currentY += 4
                    }
                    if ($vItem.isDiscovered -and -not $discoveredSepSeen) {
                        $currentY += 18
                        $discoveredSepSeen = $true
                    }
                }
                if ($script:currentPhase -eq 2 -and $vItem.ContainsKey('Type') -and ($vItem.Type -eq "session" -or $vItem.Type -eq "pm-session") -and -not $sessionSepSeen) {
                    $currentY += 9
                    $sessionSepSeen = $true
                }
                if ($mouseY -ge $currentY -and $mouseY -lt ($currentY + $itemH)) {
                    $hoverIdx = $vi
                    break
                }
                $currentY += $itemH
            }
            if ($hoverIdx -ge 0 -and $hoverIdx -ne $script:highlightIndex) {
                $script:highlightIndex = $hoverIdx
                # Reset preview on hover change (Phase 2)
                if ($script:hoverTimer) { $script:hoverTimer.Stop(); $script:hoverTimer.Start() }
                $script:previewData = @()
                $script:previewIndex = -1
                $sender.Invalidate()
            }
        } catch { }
    })

    # Left-click to select items
    $form.Add_MouseClick({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }

            # Walk Y positions to find clicked item (mirrors paint logic)
            $clickY = $e.Y
            $filterBarH = 0
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -gt 0) { $filterBarH = 28 }
            $scrollAboveH = 0
            if ($script:currentPhase -eq 1 -and $script:filterText.Length -eq 0 -and $script:scrollOffset -gt 0) { $scrollAboveH = 14 }
            $extraSessionSep = 0
            if ($script:currentPhase -eq 2) { $extraSessionSep = 0 }  # handled per-item below
            $currentY = 8 + 28 + $filterBarH + 5 + $scrollAboveH
            $itemH = 30
            $viewportItems = Get-ViewportItems
            $discoveredSepSeen = $false
            $sessionSepSeen = $false
            $clickedIdx = -1
            for ($vi = 0; $vi -lt $viewportItems.Count; $vi++) {
                $vItem = $viewportItems[$vi]
                # Phase 1 separators
                if ($script:currentPhase -eq 1) {
                    if ($vi -gt 0 -and $viewportItems[$vi - 1].ContainsKey('isSeparatorAfter') -and $viewportItems[$vi - 1].isSeparatorAfter) {
                        $currentY += 4
                    }
                    if ($vItem.isDiscovered -and -not $discoveredSepSeen) {
                        $currentY += 18
                        $discoveredSepSeen = $true
                    }
                }
                # Phase 2 session separator
                if ($script:currentPhase -eq 2 -and $vItem.ContainsKey('Type') -and ($vItem.Type -eq "session" -or $vItem.Type -eq "pm-session") -and -not $sessionSepSeen) {
                    $currentY += 9
                    $sessionSepSeen = $true
                }
                if ($clickY -ge $currentY -and $clickY -lt ($currentY + $itemH)) {
                    $clickedIdx = $vi
                    break
                }
                $currentY += $itemH
            }
            if ($clickedIdx -ge 0) {
                $script:highlightIndex = $clickedIdx
                Invoke-LauncherSelection $clickedIdx
            }
        } catch {
            Write-DockLog "error" @{ function = "MouseClick_Left"; message = $_.Exception.Message }
        }
    })

    # Right-click context menu for pin/unpin (Phase 1 only)
    $form.Add_MouseDown({
        param($sender, $e)
        $ErrorActionPreference = "Continue"
        try {
            if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Right) { return }
            if ($script:currentPhase -ne 1) { return }

            # Calculate which item was clicked by walking Y positions (mirrors paint logic)
            $clickY = $e.Y
            $filterBarH = 0
            if ($script:filterText.Length -gt 0) { $filterBarH = 28 }
            $scrollAboveH = 0
            if ($script:filterText.Length -eq 0 -and $script:scrollOffset -gt 0) { $scrollAboveH = 14 }
            $currentY = 8 + 28 + $filterBarH + 5 + $scrollAboveH  # header(8+28) + filterBar + sep(5) + scrollAbove
            $itemH = 30
            $viewportItems = Get-ViewportItems
            $discoveredSepSeen = $false
            $clickedIdx = -1
            for ($vi = 0; $vi -lt $viewportItems.Count; $vi++) {
                $vItem = $viewportItems[$vi]
                # Separator after Project Manager
                if ($vi -gt 0 -and $viewportItems[$vi - 1].ContainsKey('isSeparatorAfter') -and $viewportItems[$vi - 1].isSeparatorAfter) {
                    $currentY += 4
                }
                # Discovered separator
                if ($vItem.isDiscovered -and -not $discoveredSepSeen) {
                    $currentY += 18
                    $discoveredSepSeen = $true
                }
                if ($clickY -ge $currentY -and $clickY -lt ($currentY + $itemH)) {
                    $clickedIdx = $vi
                    break
                }
                $currentY += $itemH
            }
            if ($clickedIdx -lt 0) { return }

            $item = $viewportItems[$clickedIdx]
            if ($item.Type -ne "project") { return }

            $proj = $script:allProjects[$item.Index]
            $script:rightClickProjectPath = $proj.path
            $script:rightClickProjectName = $proj.name
            $script:rightClickIsPinned = $proj.isPinned

            $ctxMenu = New-Object System.Windows.Forms.ContextMenuStrip
            $ctxMenu.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
            $ctxMenu.ForeColor = [System.Drawing.Color]::White
            $ctxMenu.ShowImageMargin = $false
            $ctxMenu.Font = New-Object System.Drawing.Font("Consolas", 9)
            if ($proj.isPinned) {
                $unpinItem = New-Object System.Windows.Forms.ToolStripMenuItem("Unpin project")
                $unpinItem.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
                $unpinItem.ForeColor = [System.Drawing.Color]::FromArgb(232, 118, 50)
                $unpinItem.Add_Click({
                    Toggle-PinnedProject $script:rightClickProjectPath $script:rightClickProjectName
                })
                $ctxMenu.Items.Add($unpinItem) | Out-Null
            } else {
                $pinItem = New-Object System.Windows.Forms.ToolStripMenuItem("Pin project")
                $pinItem.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
                $pinItem.ForeColor = [System.Drawing.Color]::FromArgb(22, 198, 12)
                $pinItem.Add_Click({
                    Toggle-PinnedProject $script:rightClickProjectPath $script:rightClickProjectName
                })
                $ctxMenu.Items.Add($pinItem) | Out-Null
            }

            $script:contextMenuOpen = $true
            $script:activeCtxMenu = $ctxMenu
            $ctxMenu.Add_Closed({
                $script:contextMenuOpen = $false
                # Dispose the context menu and its Font to prevent GDI leaks
                if ($script:activeCtxMenu) {
                    try { $script:activeCtxMenu.Dispose() } catch { }
                    $script:activeCtxMenu = $null
                }
            })
            $ctxMenu.Show($sender, $e.Location)
        } catch {
            Write-DockLog "error" @{ function = "MouseDown_RightClick"; message = $_.Exception.Message }
        }
    })

    # Close on deactivate (unless right-click context menu is open)
    $form.Add_Deactivate({
        try {
            if (-not $script:contextMenuOpen) { Hide-Launcher }
        } catch { }
    })

    $script:launcherForm = $form

    # Feature 8: Hover timer for session preview
    $script:hoverTimer = New-Object System.Windows.Forms.Timer
    $script:hoverTimer.Interval = 500
    $script:hoverTimer.Add_Tick({
        $ErrorActionPreference = "Continue"
        try {
            $script:hoverTimer.Stop()
            if ($script:currentPhase -eq 2 -and $script:launcherForm) {
                $visibleItems = Get-VisibleItems
                if ($script:highlightIndex -lt $visibleItems.Count) {
                    $item = $visibleItems[$script:highlightIndex]
                    if ($item -and ($item.Type -eq "session" -or $item.Type -eq "pm-session") -and $item.ContainsKey('FilePath') -and $item.FilePath) {
                        $script:previewData = @(Get-SessionPreview $item.FilePath)
                        $script:previewIndex = $script:highlightIndex
                        $size = Get-LauncherSize
                        $script:launcherForm.Size = New-Object System.Drawing.Size($size.Width, $size.Height)
                        $script:launcherForm.Invalidate()
                    }
                }
            }
        } catch {
            Write-DockLog "error" @{ function = "HoverTimer"; message = $_.Exception.Message }
        }
    })

    # Feature 3: Issue poll timer (500ms)
    $script:issueTimer = New-Object System.Windows.Forms.Timer
    $script:issueTimer.Interval = 500
    $script:issueTimer.Add_Tick({
        $ErrorActionPreference = "Continue"
        try {
            $needRepaint = $false
            # Poll background git status
            $gitDone = Collect-GitStatusResults
            if ($gitDone) { $needRepaint = $true }
            # Poll background issue fetches
            $issueDone = Collect-IssueResults
            if ($issueDone) { $needRepaint = $true }
            # Poll update check
            Collect-UpdateResult
            # Repaint if data changed and launcher is visible in Phase 1
            if ($needRepaint -and $script:launcherForm -and $script:launcherForm.Visible) {
                if ($script:currentPhase -eq 1) {
                    # Preserve scroll state across background refreshes
                    $savedScroll = $script:scrollOffset
                    $savedActivated = $script:scrollActivated
                    $savedHighlight = $script:highlightIndex
                    Build-LauncherPhase1
                    $script:scrollOffset = $savedScroll
                    $script:scrollActivated = $savedActivated
                    $vpCount = (Get-ViewportItems).Count
                    $script:highlightIndex = [Math]::Min($savedHighlight, [Math]::Max(0, $vpCount - 1))
                }
                $script:launcherForm.Invalidate()
            }
        } catch {
            Write-DockLog "error" @{ function = "IssueTimer"; message = $_.Exception.Message }
        }
    })
    $script:issueTimer.Start()
}

# ============================================================
# Feature 13: Project Manager
# ============================================================
function Build-ProjectManagerPrompt {
    $lines = @()
    $lines += "# Project Inventory"
    $lines += ""
    $lines += "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    $lines += "Total projects: $($script:allProjects.Count)"
    $lines += ""

    foreach ($proj in $script:allProjects) {
        $lines += "## $($proj.name)"
        $lines += "- **Path**: ``$($proj.path)``"
        $lines += "- **Status**: $(if ($proj.isPinned) { 'Pinned' } else { 'Discovered' })"
        if ($proj.lastActivity -and $proj.lastActivity -ne [datetime]::MinValue) {
            $daysAgo = [Math]::Round(((Get-Date) - $proj.lastActivity).TotalDays, 1)
            $lines += "- **Last activity**: $($proj.lastActivity.ToString('yyyy-MM-dd HH:mm')) ($daysAgo days ago)"
        } else {
            $lines += "- **Last activity**: Unknown"
        }
        # Check for CLAUDE.md
        $claudeMd = Join-Path $proj.path "CLAUDE.md"
        if (Test-Path $claudeMd) {
            $lines += "- **CLAUDE.md**: Yes"
        } else {
            $lines += "- **CLAUDE.md**: No"
        }
        # Recent session summaries
        try {
            $slug = Get-ProjectSlug $proj.path
            $slugDir = Join-Path $script:claudeProjectsDir $slug
            if (Test-Path $slugDir) {
                $recentFiles = Get-ChildItem -Path $slugDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                    Sort-Object LastWriteTime -Descending | Select-Object -First 3
                if ($recentFiles.Count -gt 0) {
                    $lines += "- **Recent sessions**:"
                    foreach ($sf in $recentFiles) {
                        $firstLine = Get-Content $sf.FullName -TotalCount 1 -ErrorAction SilentlyContinue
                        $summary = "Session $($sf.BaseName)"
                        if ($firstLine -and $firstLine -match '"message"\s*:\s*"([^"]{1,80})"') {
                            $summary = $Matches[1]
                        }
                        $lines += "  - $($sf.LastWriteTime.ToString('MM-dd')): $summary"
                    }
                }
            }
        } catch { }
        $lines += ""
    }

    $lines += "---"
    $lines += ""
    $lines += "## Instructions"
    $lines += "You are a project manager assistant. Review the projects above and:"
    $lines += "1. Read each project's CLAUDE.md (if it exists) to understand its purpose and status"
    $lines += "2. Check for planning docs, TODOs, or roadmap files in each project"
    $lines += "3. Identify stale projects (no activity in 30+ days) and suggest whether to archive or revisit"
    $lines += "4. Suggest priorities based on recency, complexity, and apparent urgency"
    $lines += "5. Flag any outdated documentation or CLAUDE.md files that need updating"
    $lines += "6. Provide a brief prioritized action plan"
    return ($lines -join "`n")
}

function Launch-ProjectManager {
    try {
        $pmDir = Join-Path $env:USERPROFILE ".claude\project-manager"
        if (-not (Test-Path $pmDir)) {
            New-Item -Path $pmDir -ItemType Directory -Force | Out-Null
        }
        $inventoryPath = Join-Path $pmDir "project-inventory.md"
        $prompt = Build-ProjectManagerPrompt
        [System.IO.File]::WriteAllText($inventoryPath, $prompt)
        Write-DockLog "project_manager_launched" @{ inventory_path = $inventoryPath; project_count = $script:allProjects.Count }
        Start-ClaudeCmd "claude `"Read project-inventory.md and review my projects. Prioritize my work and suggest next steps.`"" $pmDir
    } catch {
        Write-DockLog "error" @{ function = "Launch-ProjectManager"; message = $_.Exception.Message }
    }
}

# ============================================================
# Launch functions (Feature 5: path safety)
# ============================================================
function Open-Explorer($path) {
    if (-not (Test-PathSafe $path)) {
        Write-DockLog "error" @{ function = "Open-Explorer"; message = "Unsafe path rejected: $path" }
        return
    }
    Start-Process explorer.exe -ArgumentList "/n,`"$path`""
}

function Open-VSCode($path) {
    if (-not $script:codeAvailable) {
        Write-DockLog "skipped" @{ function = "Open-VSCode"; reason = "VS Code not installed" }
        return
    }
    if (-not (Test-PathSafe $path)) {
        Write-DockLog "error" @{ function = "Open-VSCode"; message = "Unsafe path rejected: $path" }
        return
    }
    Start-Process cmd -ArgumentList "/c code --new-window `"$path`"" -WindowStyle Hidden
}

# Launch cmd with Claude env vars cleared inline to avoid "nested instance" detection
function Start-ClaudeCmd($claudeArgs, $path) {
    if (-not $script:claudeAvailable) {
        $script:notifyIcon.ShowBalloonTip(10000, "Claude Code not found",
            "Install Claude Code CLI: https://claude.ai/download", [System.Windows.Forms.ToolTipIcon]::Warning)
        Write-DockLog "error" @{ function = "Start-ClaudeCmd"; reason = "Claude Code CLI not installed" }
        return
    }
    if (-not (Test-PathSafe $path)) {
        Write-DockLog "error" @{ function = "Start-ClaudeCmd"; message = "Unsafe path rejected: $path" }
        return
    }
    # Build a cmd command that clears all CLAUDE* env vars before running claude
    # Key vars: CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ACCESS_TOKEN, etc.
    $clearVars = ""
    foreach ($key in @([System.Environment]::GetEnvironmentVariables().Keys)) {
        # Only process env var names that are safe alphanumeric identifiers
        if ($key -like "CLAUDE*" -and $key -ne "CLAUDE_CODE_GIT_BASH_PATH" -and $key -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            $clearVars += "set `"$key=`" & "
        }
    }
    $cmdLine = "/k $clearVars cd /d `"$path`" && $claudeArgs"
    Start-Process cmd -ArgumentList $cmdLine
}

function Launch-Project($path) {
    if (-not (Test-PathSafe $path)) { return }
    # Launch all three in parallel (Start-Process is non-blocking)
    if ($script:launchOpts.explorer) { Open-Explorer $path }
    if ($script:launchOpts.vscode)   { Open-VSCode $path }
    if ($script:launchOpts.claude) {
        Start-ClaudeCmd "claude" $path
    }
}

function Launch-ProjectContinue($path) {
    if (-not (Test-PathSafe $path)) { return }
    if ($script:launchOpts.explorer) { Open-Explorer $path }
    if ($script:launchOpts.vscode)   { Open-VSCode $path }
    Start-ClaudeCmd "claude --continue" $path
}

function Launch-ProjectResume($path, $sessionId) {
    if (-not (Test-PathSafe $path)) { return }
    # Validate session ID is a safe identifier (UUID/hex pattern)
    if ($sessionId -notmatch '^[a-zA-Z0-9_-]+$') {
        Write-DockLog "error" @{ function = "Launch-ProjectResume"; message = "Invalid session ID rejected" }
        return
    }
    if ($script:launchOpts.explorer) { Open-Explorer $path }
    if ($script:launchOpts.vscode)   { Open-VSCode $path }
    Start-ClaudeCmd "claude --resume $sessionId" $path
}

# ============================================================
# Feature 4: Launch Claude to fix an issue
# ============================================================
function Launch-IssueFixSession($path, $ghRepo, $issueNumber, $issueTitle) {
    if (-not (Test-PathSafe $path)) { return }
    # Validate issue number is a positive integer (prevents injection via malformed data)
    if ("$issueNumber" -notmatch '^\d+$') {
        Write-DockLog "error" @{ function = "Launch-IssueFixSession"; message = "Invalid issue number rejected: $issueNumber" }
        return
    }
    if ($script:launchOpts.explorer) { Open-Explorer $path }
    if ($script:launchOpts.vscode)   { Open-VSCode $path }
    # Whitelist: only allow alphanumeric, spaces, and basic punctuation. Strip everything else
    # including newlines, tabs, and all cmd.exe metacharacters
    $safeTitle = $issueTitle -replace '[^a-zA-Z0-9 .,:\-]', ''
    if ($safeTitle.Length -gt 200) { $safeTitle = $safeTitle.Substring(0, 200) }
    $prompt = "Please investigate and fix GitHub issue #$issueNumber`: $safeTitle. Use gh issue view $issueNumber to read the full details."
    Start-ClaudeCmd "claude `"$prompt`"" $path
    Write-DockLog "action_launched" @{ type = "issue_fix"; project = (Split-Path $path -Leaf); issue = $issueNumber }
}

# ============================================================
# Build context menu (tray icon)
# ============================================================
function Build-Menu() {
    try {
        $contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
        $contextMenu.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
        $contextMenu.ForeColor = [System.Drawing.Color]::White
        $contextMenu.ShowImageMargin = $false
        $contextMenu.Font = New-Object System.Drawing.Font("Segoe UI", 10)
        $contextMenu.Renderer = New-Object System.Windows.Forms.ToolStripProfessionalRenderer(
            (New-Object System.Windows.Forms.ProfessionalColorTable)
        )

        $header = New-Object System.Windows.Forms.ToolStripLabel("  CLD CTRL")
        $header.ForeColor = [System.Drawing.Color]::FromArgb(232, 118, 50)
        $header.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
        $contextMenu.Items.Add($header) | Out-Null
        $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

        foreach ($proj in $script:allProjects) {
            $projPath = $proj.path
            $projName = $proj.name
            # Use cached git statuses instead of blocking the UI thread
            $gitStatus = if ($script:launcherGitStatuses.ContainsKey($projName)) { $script:launcherGitStatuses[$projName] } else { "" }

            $projItem = New-Object System.Windows.Forms.ToolStripMenuItem($projName)
            $projItem.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
            $projItem.ForeColor = [System.Drawing.Color]::White

            if ($gitStatus) {
                $check = [char]0x2713
                $bullet = [char]0x25CF
                $upArrow = [char]0x2191
                if ($gitStatus.Contains($check)) {
                    $projItem.ForeColor = [System.Drawing.Color]::FromArgb(22, 198, 12)
                } elseif ($gitStatus.Contains($bullet) -or $gitStatus.Contains($upArrow)) {
                    $projItem.ForeColor = [System.Drawing.Color]::FromArgb(249, 241, 165)
                }
            }

            if ($gitStatus) {
                $statusLabel = New-Object System.Windows.Forms.ToolStripLabel("  $gitStatus")
                $statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8)
                $check = [char]0x2713; $bullet = [char]0x25CF; $upArrow = [char]0x2191
                if ($gitStatus.Contains($check)) {
                    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(22, 198, 12)
                } elseif ($gitStatus.Contains($bullet) -or $gitStatus.Contains($upArrow)) {
                    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(249, 241, 165)
                } else {
                    $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(118, 118, 118)
                }
                $projItem.DropDownItems.Add($statusLabel) | Out-Null
                $projItem.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
            }

            $newItem = New-Object System.Windows.Forms.ToolStripMenuItem("New Session")
            $newItem.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
            $newItem.ForeColor = [System.Drawing.Color]::White
            $newItem.Tag = $projPath
            $newItem.Add_Click({ param($sender, $e); try { Launch-Project $sender.Tag } catch { } })
            $projItem.DropDownItems.Add($newItem) | Out-Null

            $contItem = New-Object System.Windows.Forms.ToolStripMenuItem("Continue Last")
            $contItem.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
            $contItem.ForeColor = [System.Drawing.Color]::FromArgb(59, 120, 255)
            $contItem.Tag = $projPath
            $contItem.Add_Click({ param($sender, $e); try { Launch-ProjectContinue $sender.Tag } catch { } })
            $projItem.DropDownItems.Add($contItem) | Out-Null

            $projItem.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

            $sessions = Get-RecentSessions $projPath 5
            if ($sessions.Count -gt 0) {
                $recentLabel = New-Object System.Windows.Forms.ToolStripLabel("  Recent Sessions")
                $recentLabel.ForeColor = [System.Drawing.Color]::FromArgb(118, 118, 118)
                $recentLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Italic)
                $projItem.DropDownItems.Add($recentLabel) | Out-Null

                foreach ($session in $sessions) {
                    $label = "$($session.DateLabel) - $($session.Summary)"
                    if ($session.StatsLabel) { $label += "  ($($session.StatsLabel))" }
                    $sessItem = New-Object System.Windows.Forms.ToolStripMenuItem($label)
                    $sessItem.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
                    $sessItem.ForeColor = [System.Drawing.Color]::FromArgb(168, 168, 168)
                    $sessItem.Font = New-Object System.Drawing.Font("Segoe UI", 9)
                    $sessItem.Tag = @{ Path = $projPath; SessionId = $session.Id }
                    $sessItem.Add_Click({
                        param($sender, $e)
                        try {
                            $info = $sender.Tag
                            Launch-ProjectResume $info.Path $info.SessionId
                        } catch { }
                    })
                    $projItem.DropDownItems.Add($sessItem) | Out-Null
                }
            } else {
                $noSess = New-Object System.Windows.Forms.ToolStripLabel("  No recent sessions")
                $noSess.ForeColor = [System.Drawing.Color]::FromArgb(86, 86, 86)
                $noSess.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Italic)
                $projItem.DropDownItems.Add($noSess) | Out-Null
            }

            $projItem.DropDown.BackColor = [System.Drawing.Color]::FromArgb(25, 25, 25)
            $projItem.DropDown.ShowImageMargin = $false
            $contextMenu.Items.Add($projItem) | Out-Null
        }

        $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

        # Test Notifications menu item
        $testNotif = New-Object System.Windows.Forms.ToolStripMenuItem("Test Notifications")
        $testNotif.ForeColor = [System.Drawing.Color]::FromArgb(118, 118, 118)
        $testNotif.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
        $testNotif.Add_Click({
            $ErrorActionPreference = "Continue"
            try {
                # Show the launch toast
                Show-LaunchToast "TestProject" "Notification Test"
                # Show balloon after 500ms via timer (avoid blocking UI thread)
                $script:testBalloonTimer = New-Object System.Windows.Forms.Timer
                $script:testBalloonTimer.Interval = 500
                $script:testBalloonTimer.Add_Tick({
                    $ErrorActionPreference = "Continue"
                    try {
                        $script:testBalloonTimer.Stop()
                        $script:testBalloonTimer.Dispose()
                        $script:testBalloonTimer = $null
                        $script:notifyIcon.ShowBalloonTip(5000, "New issue in test/repo", "#42: This is a test notification", [System.Windows.Forms.ToolTipIcon]::Info)
                    } catch { }
                })
                $script:testBalloonTimer.Start()
                Write-DockLog "test_notifications" @{}
            } catch {
                Write-DockLog "error" @{ function = "TestNotifications"; message = $_.Exception.Message }
            }
        })
        $contextMenu.Items.Add($testNotif) | Out-Null

        $quit = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")
        $quit.ForeColor = [System.Drawing.Color]::FromArgb(197, 15, 31)
        $quit.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
        $quit.Add_Click({
            $ErrorActionPreference = "Continue"
            try {
                # Timers
                if ($script:hoverTimer) { $script:hoverTimer.Stop(); $script:hoverTimer.Dispose() }
                if ($script:issueTimer) { $script:issueTimer.Stop(); $script:issueTimer.Dispose() }
                if ($script:backgroundPollTimer) { $script:backgroundPollTimer.Stop(); $script:backgroundPollTimer.Dispose() }
                # Usage stats job
                if ($script:usageStatsJob) {
                    try { Stop-Job -Job $script:usageStatsJob -ErrorAction SilentlyContinue } catch { }
                    try { Remove-Job -Job $script:usageStatsJob -Force -ErrorAction SilentlyContinue } catch { }
                }
                # Hotkey
                if ($script:hotkeyWnd) {
                    [HotkeyInterop]::UnregisterHotKey($script:hotkeyWnd.Handle, [HotkeyInterop]::HOTKEY_ID) | Out-Null
                    $script:hotkeyWnd.Destroy()
                }
                # All background jobs
                Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
                # Toast
                if ($script:activeToastTimer) { try { $script:activeToastTimer.Stop(); $script:activeToastTimer.Dispose() } catch { } }
                if ($script:activeToast -and -not $script:activeToast.IsDisposed) { try { $script:activeToast.Close(); $script:activeToast.Dispose() } catch { } }
                # Launcher form
                if ($script:launcherForm) { try { $script:launcherForm.Dispose() } catch { } }
                # GDI resources
                if ($script:iconBitmap) { try { $script:iconBitmap.Dispose() } catch { } }
                if ($script:icoStream) { try { $script:icoStream.Dispose() } catch { } }
                if ($script:icon) { try { $script:icon.Dispose() } catch { } }
                # Tray context menu
                if ($script:notifyIcon.ContextMenuStrip) { try { $script:notifyIcon.ContextMenuStrip.Dispose() } catch { } }
                # Test balloon timer
                if ($script:testBalloonTimer) { try { $script:testBalloonTimer.Stop(); $script:testBalloonTimer.Dispose() } catch { } }
                Write-DockLog "shutdown" @{}
                # Mutex — set to null so the finally block doesn't double-release
                if ($script:singleInstanceMutex) {
                    $script:singleInstanceMutex.ReleaseMutex()
                    $script:singleInstanceMutex.Dispose()
                    $script:singleInstanceMutex = $null
                }
            } catch { }
            $script:notifyIcon.Visible = $false
            $script:notifyIcon.Dispose()
            [System.Windows.Forms.Application]::Exit()
        })
        $contextMenu.Items.Add($quit) | Out-Null

        foreach ($item in $contextMenu.Items) {
            if ($item -is [System.Windows.Forms.ToolStripSeparator]) {
                $item.BackColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
                $item.ForeColor = [System.Drawing.Color]::FromArgb(48, 48, 48)
            }
        }

        return $contextMenu
    } catch {
        Write-DockLog "error" @{ function = "Build-Menu"; message = $_.Exception.Message }
        return New-Object System.Windows.Forms.ContextMenuStrip
    }
}

# ============================================================
# System tray icon
# ============================================================
$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:notifyIcon.Icon = $script:icon
$script:notifyIcon.Text = "CLD CTRL"
$script:notifyIcon.Visible = $true

# Feature 16: BalloonTipClicked handler — clicking notification opens the launcher
$script:notifyIcon.Add_BalloonTipClicked({
    $ErrorActionPreference = "Continue"
    try {
        if ($script:launcherForm -and -not $script:launcherForm.Visible) {
            Show-Launcher
        }
    } catch {
        Write-DockLog "error" @{ function = "BalloonTipClicked"; message = $_.Exception.Message }
    }
})

# Startup notification for missing core dependency
if (-not $script:claudeAvailable) {
    $script:notifyIcon.ShowBalloonTip(10000, "Claude Code not found",
        "CLD CTRL requires Claude Code CLI. Install from https://claude.ai/download",
        [System.Windows.Forms.ToolTipIcon]::Warning)
}

# Build project list initially
Build-ProjectList

$script:notifyIcon.Add_MouseClick({
    param($sender, $e)
    $ErrorActionPreference = "Continue"
    try {
        Build-ProjectList
        # Dispose old menu to prevent GDI handle leak
        if ($script:notifyIcon.ContextMenuStrip) {
            try { $script:notifyIcon.ContextMenuStrip.Dispose() } catch { }
        }
        $menu = Build-Menu
        $script:notifyIcon.ContextMenuStrip = $menu
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -or
            $e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
            $mi = $script:notifyIcon.GetType().GetMethod("ShowContextMenu",
                [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
            $mi.Invoke($script:notifyIcon, $null)
        }
    } catch {
        Write-DockLog "error" @{ function = "TrayClick"; message = $_.Exception.Message }
    }
})

# --- Initialize launcher form ---
Initialize-LauncherForm

# ============================================================
# Feature 16/17: Background Poll Timer
# ============================================================
$script:backgroundPollTimer = New-Object System.Windows.Forms.Timer
$script:backgroundPollTimer.Interval = 30000  # 30 seconds

$script:backgroundPollTimer.Add_Tick({
    $ErrorActionPreference = "Continue"
    try {
        # --- GitHub issue notifications ---
        if ($script:config.PSObject.Properties['notifications'] -and
            $script:config.notifications.github_issues -and
            $script:config.notifications.github_issues.enabled) {

            $pollMinutes = 5
            if ($script:config.notifications.github_issues.PSObject.Properties['poll_interval_minutes']) {
                $pollMinutes = $script:config.notifications.github_issues.poll_interval_minutes
            }
            $pollMinutes = [Math]::Max(1, [Math]::Min(60, [int]$pollMinutes))
            $elapsed = ((Get-Date) - $script:lastIssuePollTime).TotalMinutes
            if ($elapsed -ge $pollMinutes) {
                Start-BackgroundIssuePoll
            }
            # Collect any completed issue fetch jobs (issueTimer may have already collected some)
            Collect-IssueResults
            # Always check for new notifications — issueCache may have been updated by issueTimer
            Check-NewIssueNotifications
        }

        # --- Usage stats tooltip ---
        if ($script:config.PSObject.Properties['notifications'] -and
            $script:config.notifications.usage_stats -and
            $script:config.notifications.usage_stats.enabled) {

            $tooltipElapsed = ((Get-Date) - $script:lastTooltipUpdate).TotalMinutes
            if ($tooltipElapsed -ge 5) {
                Start-UsageStatsJob
                $script:lastTooltipUpdate = Get-Date
            }
            Collect-UsageStatsResult
        }
    } catch {
        Write-DockLog "error" @{ function = "BackgroundPollTimer"; message = $_.Exception.Message }
    }
})

$script:backgroundPollTimer.Start()

# Kick off initial usage stats and issue poll immediately
Start-UsageStatsJob
$script:lastTooltipUpdate = Get-Date
Start-BackgroundIssuePoll

Write-DockLog "background_poll_started" @{}

# --- Parse hotkey config ---
$hotkeyModifiers = [HotkeyInterop]::MOD_CTRL
$hotkeyVk = 0x26  # VK_UP

if ($script:config.PSObject.Properties['global_hotkey'] -and $script:config.global_hotkey) {
    $hkConfig = $script:config.global_hotkey
    if ($hkConfig.PSObject.Properties['modifiers'] -and $hkConfig.modifiers) {
        $hotkeyModifiers = 0
        $modStr = $hkConfig.modifiers.ToString()
        if ($modStr -match 'Ctrl')  { $hotkeyModifiers = $hotkeyModifiers -bor [HotkeyInterop]::MOD_CTRL }
        if ($modStr -match 'Alt')   { $hotkeyModifiers = $hotkeyModifiers -bor [HotkeyInterop]::MOD_ALT }
        if ($modStr -match 'Shift') { $hotkeyModifiers = $hotkeyModifiers -bor [HotkeyInterop]::MOD_SHIFT }
        if ($modStr -match 'Win')   { $hotkeyModifiers = $hotkeyModifiers -bor [HotkeyInterop]::MOD_WIN }
    }
    if ($hkConfig.PSObject.Properties['key'] -and $hkConfig.key) {
        $keyName = $hkConfig.key.ToString()
        switch ($keyName) {
            "Up"    { $hotkeyVk = 0x26 }
            "Down"  { $hotkeyVk = 0x28 }
            "Left"  { $hotkeyVk = 0x25 }
            "Right" { $hotkeyVk = 0x27 }
            "Space" { $hotkeyVk = 0x20 }
            default {
                if ($keyName.Length -eq 1) {
                    $hotkeyVk = [int][char]$keyName.ToUpper()
                }
            }
        }
    }
}

# --- Register global hotkey (Feature 5: improved error message) ---
$script:hotkeyWnd = New-Object HotkeyWindow
$registered = [HotkeyInterop]::RegisterHotKey(
    $script:hotkeyWnd.Handle,
    [HotkeyInterop]::HOTKEY_ID,
    $hotkeyModifiers,
    $hotkeyVk
)

if (-not $registered) {
    # Feature 5: Show which modifiers+key failed
    $modNames = @()
    if ($hotkeyModifiers -band [HotkeyInterop]::MOD_CTRL) { $modNames += "Ctrl" }
    if ($hotkeyModifiers -band [HotkeyInterop]::MOD_ALT) { $modNames += "Alt" }
    if ($hotkeyModifiers -band [HotkeyInterop]::MOD_SHIFT) { $modNames += "Shift" }
    if ($hotkeyModifiers -band [HotkeyInterop]::MOD_WIN) { $modNames += "Win" }
    $keyDisplay = "0x$($hotkeyVk.ToString('X2'))"
    if ($hotkeyVk -eq 0x26) { $keyDisplay = "Up" }
    elseif ($hotkeyVk -eq 0x28) { $keyDisplay = "Down" }
    $failedCombo = ($modNames -join "+") + "+$keyDisplay"
    [System.Windows.Forms.MessageBox]::Show(
        "Failed to register global hotkey ($failedCombo).`nAnother application may be using it.`n`nTry a different hotkey in config.json > global_hotkey.",
        "CLD CTRL", "OK", "Warning") | Out-Null
    Write-DockLog "error" @{ function = "RegisterHotKey"; message = "Failed: $failedCombo" }
}

$script:hotkeyWnd.add_HotkeyPressed({
    $ErrorActionPreference = "Continue"
    try {
        Write-DockLog "hotkey_pressed" @{ phase = $script:currentPhase }
        if ($script:launcherForm.Visible) {
            Hide-Launcher
        } else {
            Show-Launcher
        }
    } catch {
        Write-DockLog "error" @{ function = "HotkeyPressed"; message = $_.Exception.Message }
    }
})

$appContext = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($appContext)

} catch {
    Write-DockLog "error" @{ function = "Main"; message = $_.Exception.Message; stack = $_.ScriptStackTrace }
} finally {
    if ($script:singleInstanceMutex) {
        try { $script:singleInstanceMutex.ReleaseMutex() } catch { }
        try { $script:singleInstanceMutex.Dispose() } catch { }
    }
}
