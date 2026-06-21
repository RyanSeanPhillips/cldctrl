# Capture a screenshot to a PNG file for cldctrl, so the path can be fed into a
# Claude Code / Codex conversation. Two modes:
#   region (default) — open the modern Windows snip overlay; the user drags a
#                      region; the result lands on the clipboard and is saved.
#   full            — capture the whole virtual screen non-interactively.
# Prints "OK" on success, "TIMEOUT" if no snip was taken, or "ERR: <msg>".
param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$Mode = 'region',
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing

  if ($Mode -eq 'full') {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output 'OK'
    return
  }

  # region: clear the clipboard, open the snip overlay, wait for an image.
  [System.Windows.Forms.Clipboard]::Clear()
  Start-Process 'ms-screenclip:'
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $img = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 350
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      break
    }
  }
  if ($null -ne $img) {
    $img.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    Write-Output 'OK'
  } else {
    Write-Output 'TIMEOUT'
  }
} catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
}
