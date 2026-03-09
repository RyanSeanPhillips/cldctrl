##
## Generate animated GIF: Ctrl+Up hotkey workflow demo.
## Renders PNG frames, then combines with ffmpeg.
##

Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$docsDir = Join-Path $scriptDir "docs"
$framesDir = Join-Path $docsDir "frames"
if (-not (Test-Path $framesDir)) { New-Item -ItemType Directory -Path $framesDir | Out-Null }

# Find ffmpeg
$ffmpeg = $null
$staticPath = Join-Path $env:APPDATA "npm\node_modules\ffmpeg-static\ffmpeg.exe"
if (Test-Path $staticPath) { $ffmpeg = $staticPath }
elseif (Get-Command ffmpeg -ErrorAction SilentlyContinue) { $ffmpeg = "ffmpeg" }
if (-not $ffmpeg) { Write-Error "ffmpeg not found. Install via: npm i -g ffmpeg-static"; exit 1 }
Write-Host "Using ffmpeg: $ffmpeg"

# ── Palette ─────────────────────────────────────────────────

$tuiBg       = [System.Drawing.Color]::FromArgb(12, 12, 12)
$tuiBorder   = [System.Drawing.Color]::FromArgb(48, 48, 48)
$tuiAccent   = [System.Drawing.Color]::FromArgb(232, 118, 50)
$tuiAccentLt = [System.Drawing.Color]::FromArgb(232, 237, 245)
$tuiText     = [System.Drawing.Color]::FromArgb(204, 204, 204)
$tuiDim      = [System.Drawing.Color]::FromArgb(128, 128, 128)
$tuiHL       = [System.Drawing.Color]::FromArgb(35, 95, 40)
$tuiGreen    = [System.Drawing.Color]::FromArgb(22, 198, 12)
$tuiYellow   = [System.Drawing.Color]::FromArgb(204, 204, 60)
$tuiRocket   = [System.Drawing.Color]::FromArgb(230, 150, 60)
$flashGreen  = [System.Drawing.Color]::FromArgb(45, 140, 50)

# ── Fonts ───────────────────────────────────────────────────

$mono     = New-Object System.Drawing.Font("Consolas", 11)
$monoSm   = New-Object System.Drawing.Font("Consolas", 10)
$monoBold = New-Object System.Drawing.Font("Consolas", 11, [System.Drawing.FontStyle]::Bold)
$hotkeyFont = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)

# ── Constants ───────────────────────────────────────────────

$W = 420
$H = 370
$innerY = 28

$ptr = [string]([char]0x203A)
$check = [string]([char]0x2713)
$bullet = [string]([char]0x25CF)
$arrowUp = [string]([char]0x2191)
$arrowDn = [string]([char]0x2193)
$arrowL  = [string]([char]0x2190)

# ── Data ────────────────────────────────────────────────────

$projects = @(
    @{ name = "CLDCTRL";       branch = "master"; status = "$check"; sColor = $tuiGreen  },
    @{ name = "WebApp";        branch = "dev";    status = "${bullet}3"; sColor = $tuiYellow },
    @{ name = "API-Server";    branch = "main";   status = "${arrowUp}2"; sColor = $tuiGreen  },
    @{ name = "Design-System"; branch = "main";   status = "$check"; sColor = $tuiGreen  },
    @{ name = "ML-Pipeline";   branch = "feat";   status = "${bullet}1"; sColor = $tuiYellow }
)

$actions = @(
    "Launch (continue last)",
    "New session",
    "Sessions (3)  $ptr",
    "Open folder",
    "Open in VS Code",
    "Open full CLD CTRL"
)

# ── Drawing helpers ─────────────────────────────────────────

function Draw-Header($gfx, $lx, $cy) {
    $rocketChars = @(
        @{ ch = [string]([char]0x2584); c = $tuiAccent },
        @{ ch = [string]([char]0x2580); c = $tuiRocket },
        @{ ch = [string]([char]0x2584); c = $tuiAccent },
        @{ ch = [string]([char]0x2580); c = $tuiRocket },
        @{ ch = [string]([char]0x2584); c = $tuiAccent }
    )
    $rcx = $lx
    foreach ($rc in $rocketChars) {
        $b = New-Object System.Drawing.SolidBrush($rc.c)
        $gfx.DrawString($rc.ch, $mono, $b, $rcx, $cy); $rcx += 10; $b.Dispose()
    }
    $b1 = New-Object System.Drawing.SolidBrush($tuiAccent)
    $gfx.DrawString("CLD", $monoBold, $b1, $rcx + 8, $cy); $b1.Dispose()
    $b2 = New-Object System.Drawing.SolidBrush($tuiAccentLt)
    $gfx.DrawString("CTRL", $monoBold, $b2, $rcx + 42, $cy); $b2.Dispose()
    $b3 = New-Object System.Drawing.SolidBrush($tuiDim)
    $gfx.DrawString("v0.1.0", $monoSm, $b3, $W - 80, $cy + 2); $b3.Dispose()
}

function Draw-Sep($gfx, $lx, $cy) {
    $p = New-Object System.Drawing.Pen($tuiBorder, 1)
    $gfx.DrawLine($p, $lx, $cy, $W - 18, $cy); $p.Dispose()
}

function Draw-Badge($gfx, $text) {
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 30))
    $gfx.FillRectangle($b, 0, 0, $W, 24); $b.Dispose()
    $tb = New-Object System.Drawing.SolidBrush($tuiDim)
    $gfx.DrawString($text, $hotkeyFont, $tb, 12, 2); $tb.Dispose()
}

function Render-ProjectList($gfx, $selIdx) {
    $lx = 18; $cy = $innerY + 16
    Draw-Header $gfx $lx $cy; $cy += 22
    Draw-Sep $gfx $lx $cy; $cy += 8

    $idx = 0
    foreach ($proj in $projects) {
        if ($idx -eq 3) {
            $cy += 4
            $db = New-Object System.Drawing.SolidBrush($tuiDim)
            $gfx.DrawString("--- Discovered ---", $monoSm, $db, $lx + 4, $cy); $db.Dispose()
            $cy += 18
        }
        if ($idx -eq $selIdx) {
            $hl = New-Object System.Drawing.SolidBrush($tuiHL)
            $gfx.FillRectangle($hl, 10, $cy - 2, $W - 20, 20); $hl.Dispose()
        }
        $pointer = if ($idx -eq $selIdx) { "$ptr " } else { "  " }
        $nc = if ($idx -eq $selIdx) { $tuiText } else { $tuiDim }
        $nf = if ($idx -eq $selIdx) { $monoBold } else { $mono }
        $nb = New-Object System.Drawing.SolidBrush($nc)
        $gfx.DrawString("$pointer$($proj.name)", $nf, $nb, $lx, $cy); $nb.Dispose()
        $brT = "$($proj.branch)  $($proj.status)"
        $brS = $gfx.MeasureString($brT, $monoSm)
        $sb = New-Object System.Drawing.SolidBrush($proj.sColor)
        $gfx.DrawString($brT, $monoSm, $sb, $W - 30 - $brS.Width, $cy + 1); $sb.Dispose()
        $cy += 22; $idx++
    }
    $cy += 8; Draw-Sep $gfx $lx $cy; $cy += 8
    $hb = New-Object System.Drawing.SolidBrush($tuiDim)
    $gfx.DrawString("$arrowUp$arrowDn nav  $ptr select  / filter  f full", $monoSm, $hb, $lx, $cy); $hb.Dispose()
}

function Render-ActionMenu($gfx, $selIdx, $flash) {
    $lx = 18; $cy = $innerY + 16
    Draw-Header $gfx $lx $cy; $cy += 22
    Draw-Sep $gfx $lx $cy; $cy += 8

    $pnb = New-Object System.Drawing.SolidBrush($tuiAccent)
    $gfx.DrawString("WebApp", $monoBold, $pnb, $lx, $cy); $pnb.Dispose()
    $cy += 24

    $idx = 0
    foreach ($act in $actions) {
        if ($idx -eq $selIdx) {
            $hlC = if ($flash) { $flashGreen } else { $tuiHL }
            $hl = New-Object System.Drawing.SolidBrush($hlC)
            $gfx.FillRectangle($hl, 10, $cy - 2, $W - 20, 20); $hl.Dispose()
        }
        $pointer = if ($idx -eq $selIdx) { "$ptr " } else { "  " }
        $c = if ($idx -eq $selIdx) { $tuiText } else { $tuiDim }
        $f = if ($idx -eq $selIdx) { $monoBold } else { $mono }
        $ab = New-Object System.Drawing.SolidBrush($c)
        $gfx.DrawString("$pointer$act", $f, $ab, $lx, $cy); $ab.Dispose()
        $cy += 22; $idx++
    }
    $cy += 12; Draw-Sep $gfx $lx $cy; $cy += 8
    $hb = New-Object System.Drawing.SolidBrush($tuiDim)
    $gfx.DrawString("$arrowUp$arrowDn nav  $ptr select  $arrowL back", $monoSm, $hb, $lx, $cy); $hb.Dispose()
}

# ── Render frames ───────────────────────────────────────────

function Save-Frame($index, $drawFn) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.Clear($tuiBg)
    $gfx.TextRenderingHint = "ClearTypeGridFit"
    $borderPen = New-Object System.Drawing.Pen($tuiBorder, 1)
    $gfx.DrawRectangle($borderPen, 8, $innerY + 6, $W - 16, $H - $innerY - 14)
    $borderPen.Dispose()
    & $drawFn $gfx
    $gfx.Dispose()
    $path = Join-Path $framesDir ("frame_{0:D3}.png" -f $index)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  Frame $index saved"
}

function Save-CenteredFrame($index, $lines) {
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.Clear($tuiBg)
    $gfx.TextRenderingHint = "ClearTypeGridFit"
    $totalH = 0
    foreach ($line in $lines) { $totalH += 24 }
    $startY = ($H - $totalH) / 2
    foreach ($line in $lines) {
        $font = if ($line.bold) { $monoBold } else { $monoSm }
        $brush = New-Object System.Drawing.SolidBrush($line.color)
        $size = $gfx.MeasureString($line.text, $font)
        $gfx.DrawString($line.text, $font, $brush, ($W - $size.Width) / 2, $startY)
        $brush.Dispose()
        $startY += 24
    }
    $gfx.Dispose()
    $path = Join-Path $framesDir ("frame_{0:D3}.png" -f $index)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  Frame $index saved"
}

Write-Host "Rendering frames..."

# Each frame is held for a specific duration.
# We'll create duplicate frames at a low fps to control timing.
# Strategy: render at 1fps equivalent, with frame duplication for timing.
# Simpler: render unique frames, then use ffmpeg concat with durations.

# Frame 1: Project list, CLDCTRL selected (show 1.5s)
Save-Frame 1 { param($g) Draw-Badge $g "Ctrl+Up  pressed"; Render-ProjectList $g 0 }

# Frame 2: WebApp selected (show 1.0s)
Save-Frame 2 { param($g) Draw-Badge $g "$arrowDn  navigate"; Render-ProjectList $g 1 }

# Frame 3: Action menu (show 1.2s)
Save-Frame 3 { param($g) Draw-Badge $g "$ptr  select project"; Render-ActionMenu $g 0 $false }

# Frame 4: Launch flash (show 0.6s)
Save-Frame 4 { param($g) Draw-Badge $g "Enter  launch!"; Render-ActionMenu $g 0 $true }

# Frame 5: "Launching Claude Code..." (show 1.5s)
Save-CenteredFrame 5 @(
    @{ text = "Launching Claude Code..."; color = $tuiGreen; bold = $true },
    @{ text = "WebApp  (dev)"; color = $tuiDim; bold = $false }
)

# Frame 6: Loop pause (show 2.0s)
Save-CenteredFrame 6 @(
    @{ text = "Press Ctrl+Up to launch again..."; color = $tuiDim; bold = $false }
)

# ── Create ffmpeg concat file ───────────────────────────────

$concatPath = Join-Path $framesDir "concat.txt"
$durations = @(1.5, 1.0, 1.2, 0.6, 1.5, 2.0)
$concatContent = ""
for ($i = 0; $i -lt $durations.Count; $i++) {
    $framePath = "frame_{0:D3}.png" -f ($i + 1)
    $concatContent += "file '$framePath'`nduration $($durations[$i])`n"
}
# Repeat last frame (ffmpeg concat requirement)
$concatContent += "file 'frame_006.png'`n"
[System.IO.File]::WriteAllText($concatPath, $concatContent.Replace("`n", "`n"))

Write-Host ""
Write-Host "Encoding with ffmpeg..."

$outPath = Join-Path $docsDir "demo.gif"

# Use ffmpeg to create high-quality animated GIF with palette generation
# Step 1: Generate optimal palette
$palettePath = Join-Path $framesDir "palette.png"
& $ffmpeg -y -f concat -safe 0 -i $concatPath `
    -vf "fps=10,palettegen=max_colors=128:stats_mode=diff" `
    $palettePath 2>&1 | Select-String "error" | ForEach-Object { Write-Host $_ }

# Step 2: Encode GIF using palette
& $ffmpeg -y -f concat -safe 0 -i $concatPath -i $palettePath `
    -lavfi "fps=10,paletteuse=dither=bayer:bayer_scale=3" `
    -loop 0 $outPath 2>&1 | Select-String "error" | ForEach-Object { Write-Host $_ }

# ── Cleanup ─────────────────────────────────────────────────

$mono.Dispose(); $monoSm.Dispose(); $monoBold.Dispose(); $hotkeyFont.Dispose()

if (Test-Path $outPath) {
    $fileSize = (Get-Item $outPath).Length
    Write-Host ""
    Write-Host "Generated demo.gif ($([math]::Round($fileSize / 1024))KB, 6 scenes, looping)"
} else {
    Write-Host "ERROR: demo.gif was not created. Check ffmpeg output above."
}
