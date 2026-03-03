Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$docsDir = Join-Path $scriptDir "docs"
if (-not (Test-Path $docsDir)) { New-Item -ItemType Directory -Path $docsDir | Out-Null }

# Colors matching the CLD CTRL palette
$bgColor = [System.Drawing.Color]::FromArgb(6, 8, 13)          # #06080d
$subBgColor = [System.Drawing.Color]::FromArgb(14, 17, 24)
$textColor = [System.Drawing.Color]::White
$dimColor = [System.Drawing.Color]::FromArgb(140, 140, 150)
$sepColor = [System.Drawing.Color]::FromArgb(40, 44, 55)
$quitColor = [System.Drawing.Color]::FromArgb(220, 80, 80)
$hoverColor = [System.Drawing.Color]::FromArgb(24, 28, 38)
$accentColor = [System.Drawing.Color]::FromArgb(232, 118, 50)   # #e87632 orange
$greenColor = [System.Drawing.Color]::FromArgb(45, 212, 191)    # #2dd4bf teal
$yellowColor = [System.Drawing.Color]::FromArgb(245, 158, 11)   # #f59e0b amber
$blueColor = [System.Drawing.Color]::FromArgb(56, 140, 255)     # #388cff blue
$statusColor = [System.Drawing.Color]::FromArgb(45, 212, 191)   # teal
$sessionDimColor = [System.Drawing.Color]::FromArgb(140, 140, 150)

$menuFont = New-Object System.Drawing.Font("Segoe UI", 12)
$headerFont = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Italic)
$smallFont = New-Object System.Drawing.Font("Segoe UI", 9)
$tinyFont = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Italic)
$statusFont = New-Object System.Drawing.Font("Segoe UI", 8)

function Draw-Panel($gfx, $x, $y, $width, $items, $borderColor, $bgFill) {
    # Draw background
    $bgBrush = New-Object System.Drawing.SolidBrush($bgFill)
    $totalH = 8
    foreach ($item in $items) {
        switch ($item.type) {
            "header"    { $totalH += 24 }
            "separator" { $totalH += 10 }
            "label"     { $totalH += 22 }
            default     { $totalH += 30 }
        }
    }
    $totalH += 8
    $gfx.FillRectangle($bgBrush, $x, $y, $width, $totalH)
    $bgBrush.Dispose()

    # Border
    $borderPen = New-Object System.Drawing.Pen($borderColor, 1)
    $gfx.DrawRectangle($borderPen, $x, $y, $width - 1, $totalH - 1)
    $borderPen.Dispose()

    $cy = $y + 8
    foreach ($item in $items) {
        $pad = $x + 12
        switch ($item.type) {
            "header" {
                $brush = New-Object System.Drawing.SolidBrush($dimColor)
                $gfx.DrawString($item.text, $headerFont, $brush, $pad, $cy + 2)
                $brush.Dispose()
                $cy += 24
            }
            "separator" {
                $pen = New-Object System.Drawing.Pen($sepColor, 1)
                $gfx.DrawLine($pen, $pad, $cy + 5, $x + $width - 12, $cy + 5)
                $pen.Dispose()
                $cy += 10
            }
            "label" {
                $brush = New-Object System.Drawing.SolidBrush($item.color)
                $gfx.DrawString($item.text, $item.font, $brush, $pad, $cy + 2)
                $brush.Dispose()
                $cy += 22
            }
            "quit" {
                $brush = New-Object System.Drawing.SolidBrush($quitColor)
                $gfx.DrawString($item.text, $menuFont, $brush, $pad, $cy + 4)
                $brush.Dispose()
                $cy += 30
            }
            default {
                if ($item.hover) {
                    $hBrush = New-Object System.Drawing.SolidBrush($hoverColor)
                    $gfx.FillRectangle($hBrush, $x + 2, $cy, $width - 4, 30)
                    $hBrush.Dispose()
                }
                $color = if ($item.color) { $item.color } else { $textColor }
                $font = if ($item.font) { $item.font } else { $menuFont }
                $brush = New-Object System.Drawing.SolidBrush($color)
                $gfx.DrawString($item.text, $font, $brush, $pad, $cy + 4)
                $brush.Dispose()

                # Arrow for submenu
                if ($item.arrow) {
                    $arrowBrush = New-Object System.Drawing.SolidBrush($dimColor)
                    $arrowChar = [string]([char]0x25B8)
                    $gfx.DrawString($arrowChar, $smallFont, $arrowBrush, $x + $width - 22, $cy + 6)
                    $arrowBrush.Dispose()
                }
                $cy += 30
            }
        }
    }
    return $totalH
}

# ============================================================
# Screenshot 1: Main menu with git status colors
# ============================================================
$img1W = 280
$img1H = 260
$bmp1 = New-Object System.Drawing.Bitmap($img1W, $img1H)
$gfx = [System.Drawing.Graphics]::FromImage($bmp1)
$gfx.Clear([System.Drawing.Color]::Transparent)
$gfx.TextRenderingHint = "ClearTypeGridFit"

$mainItems = @(
    @{ text = "CLD CTRL"; type = "header" },
    @{ text = ""; type = "separator" },
    @{ text = "Weather Dashboard"; type = "item"; color = $greenColor; arrow = $true },
    @{ text = "ML Pipeline"; type = "item"; color = $yellowColor; arrow = $true; hover = $true },
    @{ text = "React Frontend"; type = "item"; color = $greenColor; arrow = $true },
    @{ text = "API Server"; type = "item"; color = $yellowColor; arrow = $true },
    @{ text = ""; type = "separator" },
    @{ text = "Quit"; type = "quit" }
)
Draw-Panel $gfx 0 0 $img1W $mainItems $sepColor $bgColor
$gfx.Dispose()
$bmp1.Save((Join-Path $docsDir "screenshot_menu.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp1.Dispose()
Write-Host "  Generated screenshot_menu.png"

# ============================================================
# Screenshot 2: Main menu + expanded submenu
# ============================================================
$img2W = 580
$img2H = 300
$bmp2 = New-Object System.Drawing.Bitmap($img2W, $img2H)
$gfx = [System.Drawing.Graphics]::FromImage($bmp2)
$gfx.Clear([System.Drawing.Color]::Transparent)
$gfx.TextRenderingHint = "ClearTypeGridFit"

# Main menu
Draw-Panel $gfx 0 0 $img1W $mainItems $sepColor $bgColor

# Submenu (expanded from ML Pipeline)
$subItems = @(
    @{ text = "(dev " + [string]([char]0x2191) + "2 " + [string]([char]0x25CF) + "3)"; type = "label"; color = $yellowColor; font = $statusFont },
    @{ text = ""; type = "separator" },
    @{ text = "New Session"; type = "item" },
    @{ text = "Continue Last"; type = "item"; color = $blueColor },
    @{ text = ""; type = "separator" },
    @{ text = "  Recent Sessions"; type = "label"; color = [System.Drawing.Color]::FromArgb(120, 120, 120); font = $tinyFont },
    @{ text = "Feb 26 - Train classifier on..."; type = "item"; color = $sessionDimColor; font = $smallFont },
    @{ text = "Feb 24 - Fix data pipeline..."; type = "item"; color = $sessionDimColor; font = $smallFont },
    @{ text = "Feb 22 - Add batch process..."; type = "item"; color = $sessionDimColor; font = $smallFont }
)
Draw-Panel $gfx ($img1W + 2) 30 295 $subItems $sepColor $subBgColor

$gfx.Dispose()
$bmp2.Save((Join-Path $docsDir "screenshot_submenu.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp2.Dispose()
Write-Host "  Generated screenshot_submenu.png"

# ============================================================
# Screenshot 3: Tray area with rocket icon
# ============================================================
$trayW = 320
$trayH = 44
$trayBmp = New-Object System.Drawing.Bitmap($trayW, $trayH)
$gfx = [System.Drawing.Graphics]::FromImage($trayBmp)
$gfx.Clear([System.Drawing.Color]::FromArgb(6, 8, 13))

$linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(40, 44, 55), 1)
$gfx.DrawLine($linePen, 0, 0, $trayW, 0)

$trayFont = New-Object System.Drawing.Font("Segoe UI", 9)
$trayBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 180, 180))
$gfx.DrawString("^", $trayFont, $trayBrush, 8, 12)
$gfx.DrawString("Wi-Fi", $smallFont, $trayBrush, 40, 14)
$gfx.DrawString("Vol", $smallFont, $trayBrush, 90, 14)

# CLD CTRL tray icon
$rocketPath = Join-Path $docsDir "variant_c.png"
if (Test-Path $rocketPath) {
    $rocketImg = [System.Drawing.Image]::FromFile($rocketPath)
    $gfx.InterpolationMode = "NearestNeighbor"
    $gfx.DrawImage($rocketImg, 138, 8, 28, 28)
    $rocketImg.Dispose()
}

$timeBrush = New-Object System.Drawing.SolidBrush($textColor)
$gfx.DrawString("2:45 PM", $trayFont, $timeBrush, 250, 8)
$gfx.DrawString("2/27/2026", $smallFont, $trayBrush, 248, 24)

$gfx.Dispose()
$trayBmp.Save((Join-Path $docsDir "screenshot_tray.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$trayBmp.Dispose()
Write-Host "  Generated screenshot_tray.png"

Write-Host ""
Write-Host "All screenshots generated!"
