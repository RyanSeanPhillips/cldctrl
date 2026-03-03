# CLD CTRL Installer
# Usage: irm https://raw.githubusercontent.com/RyanSeanPhillips/cldctrl/main/install.ps1 | iex
#
# What it does:
#   1. Downloads CLD CTRL to %LOCALAPPDATA%\cldctrl
#   2. Optionally adds to Windows startup
#   3. Launches CLD CTRL immediately

$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "cldctrl"
$repo = "RyanSeanPhillips/cldctrl"
$branch = "main"
$baseUrl = "https://raw.githubusercontent.com/$repo/$branch"

# Files needed to run CLD CTRL
$files = @(
    "cldctrl.ps1",
    "cldctrl.vbs",
    "cldctrl.ico",
    "restart.ps1",
    "config.example.json",
    "install.bat",
    "uninstall.bat"
)

Write-Host ""
Write-Host "  CLD CTRL Installer" -ForegroundColor Cyan
Write-Host "  ====================" -ForegroundColor DarkGray
Write-Host ""

# Check PowerShell version
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Host "  ERROR: PowerShell 5.1+ required. You have $($PSVersionTable.PSVersion)" -ForegroundColor Red
    return
}

# Check if already installed
if (Test-Path (Join-Path $installDir "cldctrl.ps1")) {
    Write-Host "  CLD CTRL is already installed at:" -ForegroundColor Yellow
    Write-Host "  $installDir" -ForegroundColor Yellow
    Write-Host ""
    $choice = Read-Host "  Reinstall/update? (y/N)"
    if ($choice -ne 'y' -and $choice -ne 'Y') {
        Write-Host "  Cancelled." -ForegroundColor DarkGray
        return
    }
    Write-Host ""
}

# Create install directory
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

Write-Host "  Installing to: $installDir" -ForegroundColor DarkGray
Write-Host ""

# Download files
$downloadCount = 0
foreach ($file in $files) {
    $url = "$baseUrl/$file"
    $dest = Join-Path $installDir $file
    try {
        Write-Host "  Downloading $file..." -NoNewline -ForegroundColor DarkGray
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        Write-Host " OK" -ForegroundColor Green
        $downloadCount++
    } catch {
        Write-Host " SKIP (not found)" -ForegroundColor Yellow
    }
}

Write-Host ""

if ($downloadCount -lt 1) {
    Write-Host "  ERROR: No files downloaded. Check your internet connection." -ForegroundColor Red
    return
}

# Preserve existing config if it exists
$configPath = Join-Path $installDir "config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "  No config.json found - CLD CTRL will auto-detect your projects on first run." -ForegroundColor DarkGray
}

Write-Host "  Downloaded $downloadCount files." -ForegroundColor Green
Write-Host ""

# Offer to add to startup
$addStartup = Read-Host "  Start CLD CTRL automatically on login? (Y/n)"
if ($addStartup -ne 'n' -and $addStartup -ne 'N') {
    $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
    $ps1Path = Join-Path $installDir "cldctrl.ps1"
    $vbsLines = @(
        'Set WshShell = CreateObject("WScript.Shell")',
        ('WshShell.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $ps1Path + '""", 0, False')
    )
    [System.IO.File]::WriteAllText((Join-Path $startupDir "cldctrl.vbs"), ($vbsLines -join "`r`n"))
    Write-Host "  Added to Windows startup." -ForegroundColor Green
} else {
    Write-Host "  Skipped. Run install.bat later to add to startup." -ForegroundColor DarkGray
}

Write-Host ""

# Launch now
$launchNow = Read-Host "  Launch CLD CTRL now? (Y/n)"
if ($launchNow -ne 'n' -and $launchNow -ne 'N') {
    $vbsPath = Join-Path $installDir "cldctrl.vbs"
    if (Test-Path $vbsPath) {
        Start-Process wscript.exe -ArgumentList "`"$vbsPath`""
    } else {
        Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installDir\cldctrl.ps1`""
    }
    Write-Host "  CLD CTRL is running! Look for it in your system tray." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Install complete!" -ForegroundColor Cyan
Write-Host "  Location:  $installDir" -ForegroundColor DarkGray
Write-Host "  Uninstall: run uninstall.bat in that folder" -ForegroundColor DarkGray
Write-Host "  Hotkey:    Ctrl+Up to open the launcher" -ForegroundColor DarkGray
Write-Host ""
