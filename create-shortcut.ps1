# Creates a .lnk shortcut that can be pinned to the Windows taskbar.
# Run this script once to generate cldctrl.lnk on your Desktop.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ps1Path = Join-Path $scriptDir "cldctrl.ps1"
$iconPath = Join-Path $scriptDir "cldctrl.ico"

# --- Generate .ico file if it doesn't exist ---
if (-not (Test-Path $iconPath)) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap(64, 64)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.SmoothingMode = "AntiAlias"
    $gfx.TextRenderingHint = "AntiAliasGridFit"
    $gfx.Clear([System.Drawing.Color]::Transparent)

    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(232, 118, 50))
    $gfx.FillEllipse($bgBrush, 2, 2, 60, 60)

    $font = New-Object System.Drawing.Font("Consolas", 20, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 30))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = "Center"
    $sf.LineAlignment = "Center"
    $gfx.DrawString("C>", $font, $textBrush, (New-Object System.Drawing.RectangleF(0, -2, 64, 52)), $sf)

    $arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(30, 30, 30), 3)
    $arrowPen.StartCap = "Round"
    $arrowPen.EndCap = "Round"
    $gfx.DrawLine($arrowPen, 32, 58, 32, 46)
    $gfx.DrawLine($arrowPen, 26, 52, 32, 46)
    $gfx.DrawLine($arrowPen, 38, 52, 32, 46)
    $gfx.Dispose()

    # Save as .ico
    $stream = [System.IO.File]::Create($iconPath)
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream.Close()

    # Proper ICO format
    $pngBytes = [System.IO.File]::ReadAllBytes($iconPath)
    $icoStream = [System.IO.File]::Create($iconPath)
    $writer = New-Object System.IO.BinaryWriter($icoStream)
    # ICO header
    $writer.Write([UInt16]0)      # reserved
    $writer.Write([UInt16]1)      # type: icon
    $writer.Write([UInt16]1)      # count: 1 image
    # ICO directory entry
    $writer.Write([byte]64)       # width
    $writer.Write([byte]64)       # height
    $writer.Write([byte]0)        # color palette
    $writer.Write([byte]0)        # reserved
    $writer.Write([UInt16]1)      # color planes
    $writer.Write([UInt16]32)     # bits per pixel
    $writer.Write([UInt32]$pngBytes.Length)  # image size
    $writer.Write([UInt32]22)     # offset to image data
    # Image data (PNG)
    $writer.Write($pngBytes)
    $writer.Close()
    $icoStream.Close()

    Write-Host "Generated cldctrl.ico"
}

# --- Create shortcut ---
$desktopPath = [System.Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "CLD CTRL.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1Path`""
$shortcut.WorkingDirectory = $scriptDir
$shortcut.IconLocation = $iconPath
$shortcut.Description = "CLD CTRL - Mission control for Claude Code"
$shortcut.Save()

Write-Host ""
Write-Host "Shortcut created at: $shortcutPath"
Write-Host ""
Write-Host "To pin to taskbar:"
Write-Host "  1. Right-click 'CLD CTRL' on your Desktop"
Write-Host "  2. Select 'Show more options' (Win 11)"
Write-Host "  3. Select 'Pin to taskbar'"
Write-Host ""
