$icoPath = Join-Path $PSScriptRoot "ClaudeDock.ico"
$bytes = [System.IO.File]::ReadAllBytes($icoPath)
Write-Host "File size: $($bytes.Length) bytes"

$reserved = [BitConverter]::ToUInt16($bytes, 0)
$type = [BitConverter]::ToUInt16($bytes, 2)
$count = [BitConverter]::ToUInt16($bytes, 4)
Write-Host "ICO header: reserved=$reserved type=$type count=$count"

for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + $i * 16
    $w = $bytes[$off]; $h = $bytes[$off+1]; $colors = $bytes[$off+2]
    $planes = [BitConverter]::ToUInt16($bytes, $off+4)
    $bitcount = [BitConverter]::ToUInt16($bytes, $off+6)
    $sz = [BitConverter]::ToUInt32($bytes, $off+8)
    $dataOff = [BitConverter]::ToUInt32($bytes, $off+12)
    Write-Host "Entry $i`: ${w}x${h}, colors=$colors, planes=$planes, bits=$bitcount, dataSize=$sz, offset=$dataOff"

    if ($dataOff + 4 -le $bytes.Length) {
        $isPng = ($bytes[$dataOff] -eq 0x89 -and $bytes[$dataOff+1] -eq 0x50)
        Write-Host "  Is PNG: $isPng"
        $magic = "$($bytes[$dataOff].ToString('X2')) $($bytes[$dataOff+1].ToString('X2')) $($bytes[$dataOff+2].ToString('X2')) $($bytes[$dataOff+3].ToString('X2'))"
        Write-Host "  Magic: $magic"
    }
}

# Try loading as Image via stream
Add-Type -AssemblyName System.Drawing
try {
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    $img = [System.Drawing.Image]::FromStream($ms)
    Write-Host "Image.FromStream: $($img.Width)x$($img.Height) format=$($img.RawFormat)"
    $img.Dispose(); $ms.Dispose()
} catch {
    Write-Host "Image.FromStream failed: $($_.Exception.Message)"
}

# Try Bitmap constructor with stream
try {
    $ms2 = New-Object System.IO.MemoryStream(,$bytes)
    $bmp = New-Object System.Drawing.Bitmap($ms2)
    Write-Host "Bitmap from stream: $($bmp.Width)x$($bmp.Height)"
    $bmp.Dispose(); $ms2.Dispose()
} catch {
    Write-Host "Bitmap from stream failed: $($_.Exception.Message)"
}

# If it's PNG inside, extract the PNG data and load that
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + $i * 16
    $sz = [BitConverter]::ToUInt32($bytes, $off+8)
    $dataOff = [BitConverter]::ToUInt32($bytes, $off+12)
    if ($bytes[$dataOff] -eq 0x89 -and $bytes[$dataOff+1] -eq 0x50) {
        Write-Host "Extracting PNG from entry $i (offset=$dataOff, size=$sz)..."
        $pngBytes = New-Object byte[] $sz
        [Array]::Copy($bytes, $dataOff, $pngBytes, 0, $sz)
        try {
            $pngStream = New-Object System.IO.MemoryStream(,$pngBytes)
            $pngBmp = New-Object System.Drawing.Bitmap($pngStream)
            Write-Host "PNG bitmap: $($pngBmp.Width)x$($pngBmp.Height)"
            $pngBmp.Dispose(); $pngStream.Dispose()
        } catch {
            Write-Host "PNG load failed: $($_.Exception.Message)"
        }
    }
}
