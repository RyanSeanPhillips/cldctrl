Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$docsDir = Join-Path $scriptDir "docs"
if (-not (Test-Path $docsDir)) { New-Item -ItemType Directory -Path $docsDir | Out-Null }

# ── Color palettes ──────────────────────────────────────────

# PowerShell tray app palette
$bgColor = [System.Drawing.Color]::FromArgb(6, 8, 13)
$subBgColor = [System.Drawing.Color]::FromArgb(14, 17, 24)
$textColor = [System.Drawing.Color]::White
$dimColor = [System.Drawing.Color]::FromArgb(140, 140, 150)
$sepColor = [System.Drawing.Color]::FromArgb(40, 44, 55)
$quitColor = [System.Drawing.Color]::FromArgb(220, 80, 80)
$hoverColor = [System.Drawing.Color]::FromArgb(24, 28, 38)
$accentColor = [System.Drawing.Color]::FromArgb(232, 118, 50)
$greenColor = [System.Drawing.Color]::FromArgb(45, 212, 191)
$yellowColor = [System.Drawing.Color]::FromArgb(245, 158, 11)
$blueColor = [System.Drawing.Color]::FromArgb(56, 140, 255)
$sessionDimColor = [System.Drawing.Color]::FromArgb(140, 140, 150)

# Node TUI palette (matches INK_COLORS in constants.ts)
$tuiBg       = [System.Drawing.Color]::FromArgb(12, 12, 12)
$tuiBorder   = [System.Drawing.Color]::FromArgb(48, 48, 48)
$tuiAccent   = [System.Drawing.Color]::FromArgb(232, 118, 50)   # CLD orange
$tuiAccentLt = [System.Drawing.Color]::FromArgb(232, 237, 245)  # CTRL white
$tuiText     = [System.Drawing.Color]::FromArgb(204, 204, 204)
$tuiDim      = [System.Drawing.Color]::FromArgb(128, 128, 128)
$tuiHL       = [System.Drawing.Color]::FromArgb(35, 95, 40)     # selected row
$tuiGreen    = [System.Drawing.Color]::FromArgb(22, 198, 12)    # terminal green
$tuiYellow   = [System.Drawing.Color]::FromArgb(204, 204, 60)
$tuiRed      = [System.Drawing.Color]::FromArgb(204, 60, 60)
$tuiBlue     = [System.Drawing.Color]::FromArgb(56, 140, 255)
$tuiRocket   = [System.Drawing.Color]::FromArgb(230, 150, 60)

# ── Fonts ───────────────────────────────────────────────────

$menuFont    = New-Object System.Drawing.Font("Segoe UI", 12)
$headerFont  = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Italic)
$smallFont   = New-Object System.Drawing.Font("Segoe UI", 9)
$tinyFont    = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Italic)
$statusFont  = New-Object System.Drawing.Font("Segoe UI", 8)

$mono        = New-Object System.Drawing.Font("Consolas", 11)
$monoSm      = New-Object System.Drawing.Font("Consolas", 10)
$monoBold    = New-Object System.Drawing.Font("Consolas", 11, [System.Drawing.FontStyle]::Bold)
$monoSmBold  = New-Object System.Drawing.Font("Consolas", 10, [System.Drawing.FontStyle]::Bold)

# ── Unicode chars ───────────────────────────────────────────

$ptr      = [string]([char]0x203A)  # ›
$bullet   = [string]([char]0x25CF) # ●
$check    = [string]([char]0x2713) # ✓
$warning  = [string]([char]0x26A0) # ⚠
$arrowUp  = [string]([char]0x2191) # ↑
$arrowDn  = [string]([char]0x2193) # ↓
$sepChar  = [string]([char]0x2500) # ─
$eqChar   = [string]([char]0x2550) # ═

# ── Helper: Draw panel (PowerShell tray style) ──────────────

function Draw-Panel($gfx, $x, $y, $width, $items, $borderColor, $bgFill) {
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
                $brush.Dispose(); $cy += 24
            }
            "separator" {
                $pen = New-Object System.Drawing.Pen($sepColor, 1)
                $gfx.DrawLine($pen, $pad, $cy + 5, $x + $width - 12, $cy + 5)
                $pen.Dispose(); $cy += 10
            }
            "label" {
                $brush = New-Object System.Drawing.SolidBrush($item.color)
                $gfx.DrawString($item.text, $item.font, $brush, $pad, $cy + 2)
                $brush.Dispose(); $cy += 22
            }
            "quit" {
                $brush = New-Object System.Drawing.SolidBrush($quitColor)
                $gfx.DrawString($item.text, $menuFont, $brush, $pad, $cy + 4)
                $brush.Dispose(); $cy += 30
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
                if ($item.arrow) {
                    $arrowBrush = New-Object System.Drawing.SolidBrush($dimColor)
                    $gfx.DrawString([string]([char]0x25B8), $smallFont, $arrowBrush, $x + $width - 22, $cy + 6)
                    $arrowBrush.Dispose()
                }
                $cy += 30
            }
        }
    }
    return $totalH
}

# ── Helper: draw text at position ───────────────────────────

function DT($gfx, $text, $font, $color, $x, $y) {
    $b = New-Object System.Drawing.SolidBrush($color)
    $gfx.DrawString($text, $font, $b, $x, $y)
    $b.Dispose()
}

function Get-TextSize($gfx, $text, $font) {
    return $gfx.MeasureString($text, $font)
}

function Draw-Separator($gfx, $x, $y, $width) {
    $p = New-Object System.Drawing.Pen($tuiBorder, 1)
    $gfx.DrawLine($p, $x, $y, $x + $width, $y)
    $p.Dispose()
}

function Draw-RocketHeader($gfx, $lx, $cy, $rightEdge) {
    $chars = @(
        @{ ch = [string]([char]0x2584); c = $tuiAccent },
        @{ ch = [string]([char]0x2580); c = $tuiRocket },
        @{ ch = [string]([char]0x2584); c = $tuiAccent },
        @{ ch = [string]([char]0x2580); c = $tuiRocket },
        @{ ch = [string]([char]0x2584); c = $tuiAccent }
    )
    $rcx = $lx
    foreach ($rc in $chars) {
        DT $gfx $rc.ch $mono $rc.c $rcx $cy; $rcx += 10
    }
    DT $gfx "CLD" $monoBold $tuiAccent ($rcx + 8) $cy
    DT $gfx "CTRL" $monoBold $tuiAccentLt ($rcx + 42) $cy
    DT $gfx "v0.1.0" $monoSm $tuiDim ($rightEdge - 52) ($cy + 2)
}

# ============================================================
# Screenshots 1-3: PowerShell tray app (unchanged)
# ============================================================
Write-Host "Generating tray app screenshots..."

$img1W = 280; $img1H = 260
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
Write-Host "  screenshot_menu.png"

$img2W = 580; $img2H = 300
$bmp2 = New-Object System.Drawing.Bitmap($img2W, $img2H)
$gfx = [System.Drawing.Graphics]::FromImage($bmp2)
$gfx.Clear([System.Drawing.Color]::Transparent)
$gfx.TextRenderingHint = "ClearTypeGridFit"
Draw-Panel $gfx 0 0 $img1W $mainItems $sepColor $bgColor
$subItems = @(
    @{ text = "(dev ${arrowUp}2 ${bullet}3)"; type = "label"; color = $yellowColor; font = $statusFont },
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
Write-Host "  screenshot_submenu.png"

$trayW = 320; $trayH = 44
$trayBmp = New-Object System.Drawing.Bitmap($trayW, $trayH)
$gfx = [System.Drawing.Graphics]::FromImage($trayBmp)
$gfx.Clear([System.Drawing.Color]::FromArgb(6, 8, 13))
$linePen = New-Object System.Drawing.Pen($sepColor, 1)
$gfx.DrawLine($linePen, 0, 0, $trayW, 0); $linePen.Dispose()
$trayFont = New-Object System.Drawing.Font("Segoe UI", 9)
$trayBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 180, 180))
$gfx.DrawString("^", $trayFont, $trayBrush, 8, 12)
$gfx.DrawString("Wi-Fi", $smallFont, $trayBrush, 40, 14)
$gfx.DrawString("Vol", $smallFont, $trayBrush, 90, 14)
$rocketPath = Join-Path $docsDir "variant_c.png"
if (Test-Path $rocketPath) {
    $rocketImg = [System.Drawing.Image]::FromFile($rocketPath)
    $gfx.InterpolationMode = "NearestNeighbor"
    $gfx.DrawImage($rocketImg, 138, 8, 28, 28)
    $rocketImg.Dispose()
}
$timeBrush = New-Object System.Drawing.SolidBrush($textColor)
$gfx.DrawString("2:45 PM", $trayFont, $timeBrush, 250, 8)
$gfx.DrawString("3/6/2026", $smallFont, $trayBrush, 248, 24)
$gfx.Dispose()
$trayBmp.Save((Join-Path $docsDir "screenshot_tray.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$trayBmp.Dispose()
Write-Host "  screenshot_tray.png"

# ============================================================
# Screenshot 4: Mini TUI popup — project list
# ============================================================
Write-Host ""
Write-Host "Generating Node TUI screenshots..."

$miniW = 420; $miniH = 340
$miniBmp = New-Object System.Drawing.Bitmap($miniW, $miniH)
$gfx = [System.Drawing.Graphics]::FromImage($miniBmp)
$gfx.Clear($tuiBg)
$gfx.TextRenderingHint = "ClearTypeGridFit"

$borderPen = New-Object System.Drawing.Pen($tuiBorder, 1)
$gfx.DrawRectangle($borderPen, 8, 8, $miniW - 16, $miniH - 16)
$borderPen.Dispose()

$lx = 18; $cy = 18
Draw-RocketHeader $gfx $lx $cy ($miniW - 10)
$cy += 22; Draw-Separator $gfx $lx $cy ($miniW - 36); $cy += 8

$miniProjects = @(
    @{ name = "CLDCTRL";       branch = "master"; status = "$check";       sColor = $tuiGreen;  sel = $false },
    @{ name = "WebApp";        branch = "dev";    status = "${bullet}3";   sColor = $tuiYellow; sel = $true  },
    @{ name = "API-Server";    branch = "main";   status = "${arrowUp}2";  sColor = $tuiGreen;  sel = $false },
    @{ name = "Design-System"; branch = "main";   status = "$check";       sColor = $tuiGreen;  sel = $false },
    @{ name = "ML-Pipeline";   branch = "feat";   status = "${bullet}1";   sColor = $tuiYellow; sel = $false }
)

$idx = 0
foreach ($p in $miniProjects) {
    if ($idx -eq 3) {
        $cy += 4; DT $gfx "${sepChar}${sepChar}${sepChar} Discovered ${sepChar}${sepChar}${sepChar}" $monoSm $tuiDim ($lx + 4) $cy; $cy += 18
    }
    if ($p.sel) {
        $hl = New-Object System.Drawing.SolidBrush($tuiHL)
        $gfx.FillRectangle($hl, 10, $cy - 2, $miniW - 20, 20); $hl.Dispose()
    }
    $pointer = if ($p.sel) { "$ptr " } else { "  " }
    $nc = if ($p.sel) { $tuiText } else { $tuiDim }
    $nf = if ($p.sel) { $monoBold } else { $mono }
    DT $gfx "$pointer$($p.name)" $nf $nc $lx $cy
    $brT = "$($p.branch)  $($p.status)"
    $brS = Get-TextSize $gfx $brT $monoSm
    DT $gfx $brT $monoSm $p.sColor ($miniW - 30 - $brS.Width) ($cy + 1)
    $cy += 22; $idx++
}

$cy += 8; Draw-Separator $gfx $lx $cy ($miniW - 36); $cy += 8
DT $gfx "${arrowUp}${arrowDn} nav  $ptr select  / filter  f full" $monoSm $tuiDim $lx $cy

$gfx.Dispose()
$miniBmp.Save((Join-Path $docsDir "screenshot_mini.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$miniBmp.Dispose()
Write-Host "  screenshot_mini.png"

# ============================================================
# Screenshot 5: Mini TUI — action menu
# ============================================================
$actW = 420; $actH = 300
$actBmp = New-Object System.Drawing.Bitmap($actW, $actH)
$gfx = [System.Drawing.Graphics]::FromImage($actBmp)
$gfx.Clear($tuiBg)
$gfx.TextRenderingHint = "ClearTypeGridFit"
$borderPen = New-Object System.Drawing.Pen($tuiBorder, 1)
$gfx.DrawRectangle($borderPen, 8, 8, $actW - 16, $actH - 16)
$borderPen.Dispose()

$lx = 18; $cy = 18
Draw-RocketHeader $gfx $lx $cy ($actW - 10)
$cy += 22; Draw-Separator $gfx $lx $cy ($actW - 36); $cy += 8
DT $gfx "WebApp" $monoBold $tuiAccent $lx $cy; $cy += 24

$actItems = @("Launch (continue last)", "New session", "Sessions (3)  $ptr", "Open folder", "Open in VS Code", "Open full CLD CTRL")
$ai = 0
foreach ($act in $actItems) {
    if ($ai -eq 0) {
        $hl = New-Object System.Drawing.SolidBrush($tuiHL)
        $gfx.FillRectangle($hl, 10, $cy - 2, $actW - 20, 20); $hl.Dispose()
    }
    $pointer = if ($ai -eq 0) { "$ptr " } else { "  " }
    $c = if ($ai -eq 0) { $tuiText } else { $tuiDim }
    $f = if ($ai -eq 0) { $monoBold } else { $mono }
    DT $gfx "$pointer$act" $f $c $lx $cy; $cy += 22; $ai++
}
$cy += 12; Draw-Separator $gfx $lx $cy ($actW - 36); $cy += 8
$leftArrow = [string]([char]0x2190)
DT $gfx "${arrowUp}${arrowDn} nav  $ptr select  $leftArrow back" $monoSm $tuiDim $lx $cy

$gfx.Dispose()
$actBmp.Save((Join-Path $docsDir "screenshot_mini_actions.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$actBmp.Dispose()
Write-Host "  screenshot_mini_actions.png"

# ============================================================
# Screenshot 6: Full TUI — accurate split-pane
# ============================================================

$fullW = 820; $fullH = 520
$fullBmp = New-Object System.Drawing.Bitmap($fullW, $fullH)
$gfx = [System.Drawing.Graphics]::FromImage($fullBmp)
$gfx.Clear($tuiBg)
$gfx.TextRenderingHint = "ClearTypeGridFit"

$divX = [int]($fullW * 0.38)   # left pane 38%
$rightW = $fullW - $divX

# ── LEFT PANE border ──
$borderPen = New-Object System.Drawing.Pen($tuiAccent, 1)
$gfx.DrawRectangle($borderPen, 4, 4, $divX - 6, $fullH - 30)
$borderPen.Dispose()

$lx = 14; $cy = 12

# Header
Draw-RocketHeader $gfx $lx $cy ($divX - 10)
$cy += 24

# "Projects" title
DT $gfx "Projects" $monoBold $tuiAccent $lx $cy; $cy += 20

# Project list
$fullProjects = @(
    @{ name = "CLDCTRL";         branch = "master"; status = "$check";       sColor = $tuiGreen;  sel = $false; active = $null },
    @{ name = "WebApp";          branch = "dev";    status = "${bullet}3";   sColor = $tuiYellow; sel = $true;  active = $null },
    @{ name = "API-Server";      branch = "main";   status = "";             sColor = $tuiGreen;  sel = $false; active = "writing 12m 45k" },
    @{ name = "React Frontend";  branch = "main";   status = "$check";       sColor = $tuiGreen;  sel = $false; active = $null },
    @{ name = "Design System";   branch = "main";   status = "$check";       sColor = $tuiGreen;  sel = $false; active = $null }
)

foreach ($p in $fullProjects) {
    if ($p.sel) {
        $hl = New-Object System.Drawing.SolidBrush($tuiHL)
        $gfx.FillRectangle($hl, 6, $cy - 2, $divX - 10, 20); $hl.Dispose()
    }
    $pointer = if ($p.sel) { "$ptr " } else { "  " }
    $nc = if ($p.sel) { $tuiText } else { $tuiDim }
    $nf = if ($p.sel) { $monoBold } else { $mono }

    # Name
    $nameMax = 18
    $nameStr = $p.name.Substring(0, [Math]::Min($p.name.Length, $nameMax)).PadRight($nameMax)
    DT $gfx "$pointer$nameStr" $nf $nc $lx $cy

    if ($p.active) {
        # Active session badge: ● writing 12m 45k
        DT $gfx "$bullet" $mono $tuiGreen ($lx + (Get-TextSize $gfx "$pointer$nameStr " $mono).Width) $cy
        DT $gfx $p.active $monoSm $tuiDim ($lx + (Get-TextSize $gfx "$pointer$nameStr $bullet " $mono).Width) ($cy + 1)
    } else {
        # Git status on right
        $brT = "$($p.branch) $($p.status)"
        $brS = Get-TextSize $gfx $brT $monoSm
        DT $gfx $brT $monoSm $p.sColor ($divX - 16 - $brS.Width) ($cy + 1)
    }

    # Issue badge
    if ($p.name -eq "WebApp") {
        DT $gfx " ${warning}2" $monoSm $tuiAccent ($divX - 38) ($cy + 1)
    }

    $cy += 22
}

# ── Commands section ──
$cy += 8
DT $gfx "${sepChar}${sepChar}${sepChar} Commands ${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}${sepChar}" $monoSm $tuiDim $lx $cy; $cy += 18
DT $gfx " /commit" $monoSm $tuiAccent $lx $cy
DT $gfx "Create a git commit" $monoSm $tuiDim ($lx + 100) $cy
DT $gfx "5x" $monoSm $tuiText ($divX - 36) $cy; $cy += 16
DT $gfx " /review" $monoSm $tuiGreen $lx $cy
DT $gfx "Multi-agent review" $monoSm $tuiDim ($lx + 100) $cy
DT $gfx "3x" $monoSm $tuiText ($divX - 36) $cy; $cy += 16
DT $gfx " /simplify" $monoSm $tuiGreen $lx $cy
DT $gfx "Refactor for quality" $monoSm $tuiDim ($lx + 100) $cy
DT $gfx "2x" $monoSm $tuiText ($divX - 36) $cy; $cy += 16
DT $gfx " /init" $monoSm $tuiBlue $lx $cy
DT $gfx "Set up CLAUDE.md" $monoSm $tuiDim ($lx + 100) $cy; $cy += 16
DT $gfx " +4 more" $monoSm $tuiDim $lx $cy; $cy += 16
DT $gfx " ?  full list" $monoSm $tuiDim $lx $cy; $cy += 22

# ── Usage stats at bottom of left pane ──
Draw-Separator $gfx $lx $cy ($divX - 28); $cy += 8

# Calendar heatmap (simplified)
DT $gfx "Usage" $monoSm $tuiDim $lx $cy; $cy += 16
$heatmapColors = @($tuiBg, [System.Drawing.Color]::FromArgb(20, 60, 20), [System.Drawing.Color]::FromArgb(30, 100, 30), [System.Drawing.Color]::FromArgb(35, 150, 35), $tuiGreen)
$rand = New-Object System.Random(42)
for ($row = 0; $row -lt 4; $row++) {
    for ($col = 0; $col -lt 7; $col++) {
        $intensity = $rand.Next(0, 5)
        $cellColor = $heatmapColors[$intensity]
        $b = New-Object System.Drawing.SolidBrush($cellColor)
        $gfx.FillRectangle($b, $lx + $col * 14, $cy + $row * 14, 12, 12)
        $b.Dispose()
    }
}
$cy += 60

# Today's stats
DT $gfx "47 msgs $bullet 128k tok" $monoSm $tuiDim $lx $cy; $cy += 16

# Budget bar
DT $gfx "Budget " $monoSm $tuiDim $lx $cy
$barX = $lx + 56; $barW = $divX - 80
$bgBar = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 30))
$gfx.FillRectangle($bgBar, $barX, $cy + 2, $barW, 10); $bgBar.Dispose()
$fillW = [int]($barW * 0.62)
$fillBar = New-Object System.Drawing.SolidBrush($tuiGreen)
$gfx.FillRectangle($fillBar, $barX, $cy + 2, $fillW, 10); $fillBar.Dispose()
DT $gfx "62%" $monoSm $tuiText ($barX + $barW + 4) ($cy - 1)

# ── RIGHT PANE ──
$borderPen = New-Object System.Drawing.Pen($tuiBorder, 1)
$gfx.DrawRectangle($borderPen, $divX + 2, 4, $rightW - 8, $fullH - 30)
$borderPen.Dispose()

$rx = $divX + 14; $ry = 12

# Project name
DT $gfx "WebApp" $monoBold $tuiText $rx $ry; $ry += 20

# Per-project calendar heatmap
DT $gfx "Usage $sepChar WebApp" $monoSm $tuiDim $rx $ry; $ry += 16
for ($row = 0; $row -lt 3; $row++) {
    for ($col = 0; $col -lt 7; $col++) {
        $intensity = $rand.Next(0, 5)
        $cellColor = $heatmapColors[$intensity]
        $b = New-Object System.Drawing.SolidBrush($cellColor)
        $gfx.FillRectangle($b, $rx + $col * 14, $ry + $row * 14, 12, 12)
        $b.Dispose()
    }
}
$ry += 48

# Git + issues
DT $gfx "dev ${arrowUp}2 ${bullet}3" $monoSm $tuiYellow $rx $ry
DT $gfx " | " $monoSm $tuiDim ($rx + 80) $ry
DT $gfx "2 open issues" $monoSm $tuiAccent ($rx + 100) $ry; $ry += 22

# Active session banner
DT $gfx "${bullet} idle 3m" $monoSm $tuiYellow $rx $ry
DT $gfx " 12k tok 8 msgs" $monoSm $tuiDim ($rx + 68) $ry; $ry += 22

# Actions
DT $gfx "[n]" $monoSm $tuiAccent $rx $ry
DT $gfx " New session  " $monoSm $tuiText ($rx + 24) $ry
DT $gfx "[Enter]" $monoSm $tuiAccent ($rx + 126) $ry
DT $gfx " Resume" $monoSm $tuiText ($rx + 170) $ry; $ry += 24

# Tab bar: [s] Sessions  [c] Commits  [i] Issues — Sessions active
DT $gfx "[s]" $monoSm $tuiAccent $rx $ry
DT $gfx " Sessions (4)" $monoSmBold $tuiAccent ($rx + 24) $ry
DT $gfx "  [c]" $monoSm $tuiDim ($rx + 130) $ry
DT $gfx " Commits (12)" $monoSm $tuiDim ($rx + 164) $ry
DT $gfx "  [i]" $monoSm $tuiDim ($rx + 276) $ry
DT $gfx " Issues (2)" $monoSm $tuiDim ($rx + 310) $ry; $ry += 16

# Tab underline
$sessLabelLen = 16 * 8  # approximate pixel width
DT $gfx ($eqChar * 16) $monoSm $tuiAccent $rx $ry; $ry += 18

# Session list
$sessions = @(
    @{ date = "2h ago "; summary = "Fix auth middleware bug";      tokens = "1.2k"; sel = $true  },
    @{ date = "1d ago "; summary = "Add rate limiter to API";      tokens = "890";  sel = $false },
    @{ date = "2d ago "; summary = "Refactor database queries";    tokens = "2.1k"; sel = $false },
    @{ date = "Mar 1  "; summary = "Set up CI/CD pipeline";        tokens = "450";  sel = $false }
)

foreach ($s in $sessions) {
    if ($s.sel) {
        $hl = New-Object System.Drawing.SolidBrush($tuiHL)
        $gfx.FillRectangle($hl, $divX + 4, $ry - 2, $rightW - 12, 20); $hl.Dispose()
    }
    $pointer = if ($s.sel) { "$ptr " } else { "  " }
    $sc = if ($s.sel) { $tuiText } else { $tuiDim }
    $sf = if ($s.sel) { $monoBold } else { $monoSm }
    DT $gfx "$pointer$($s.date) `"$($s.summary)`"" $sf $sc $rx $ry
    $tokS = Get-TextSize $gfx $s.tokens $monoSm
    DT $gfx $s.tokens $monoSm $tuiAccent ($divX + $rightW - 20 - $tokS.Width) ($ry + 1)
    $ry += 22
}

# ── Preview area (AI summary for selected session) ──
$ry += 4
Draw-Separator $gfx $rx ($ry) ($rightW - 28); $ry += 8

# Session stats line
DT $gfx "2h ago $bullet 1.2k tok $bullet 23 msgs $bullet 8w 12r 3bash $bullet sonnet" $monoSmBold $tuiText $rx $ry; $ry += 18

# MCP server usage
DT $gfx "MCP codeindex: 5 calls $sepChar search(3) annotate(2)" $monoSm $tuiBlue $rx $ry; $ry += 20

# AI-generated rich summary (this is the Sonnet summary)
$summaryLines = @(
    "Fixed authentication middleware that was rejecting",
    "valid JWT tokens after DST change. Root cause was",
    "timezone-naive Date comparison in token expiry check.",
    "Added regression test covering edge cases around",
    "midnight UTC transitions."
)
foreach ($line in $summaryLines) {
    DT $gfx $line $monoSm $tuiText $rx $ry; $ry += 16
}

# ── STATUS BAR ──
$statusY = $fullH - 22
$sbBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 20, 20))
$gfx.FillRectangle($sbBg, 0, $statusY, $fullW, 22); $sbBg.Dispose()
DT $gfx "j/k:nav  /:filter  n:new+prompt  Enter:launch  o:folder  p:pin  ?:help  q:quit" $monoSm $tuiDim 14 ($statusY + 3)
DT $gfx "47 msgs $bullet 128k tok" $monoSm $tuiAccent ($fullW - 150) ($statusY + 3)

$gfx.Dispose()
$fullBmp.Save((Join-Path $docsDir "screenshot_full_tui.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$fullBmp.Dispose()
Write-Host "  screenshot_full_tui.png"

# ── Cleanup ─────────────────────────────────────────────────
$menuFont.Dispose(); $headerFont.Dispose(); $smallFont.Dispose()
$tinyFont.Dispose(); $statusFont.Dispose()
$mono.Dispose(); $monoSm.Dispose(); $monoBold.Dispose(); $monoSmBold.Dispose()

Write-Host ""
Write-Host "All screenshots generated in docs/"
