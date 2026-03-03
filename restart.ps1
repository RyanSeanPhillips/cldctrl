# Kill existing CLD CTRL and restart
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
    $_.Id -ne $PID -and $_.MainWindowTitle -ne 'CLD CTRL v4'
} | Out-Null

# Kill by command line match
Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    ($_.CommandLine -like "*cldctrl.ps1*" -or $_.CommandLine -like "*ClaudeDock.ps1*") -and $_.ProcessId -ne $PID
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
"" | Set-Content (Join-Path $PSScriptRoot "debug.log")
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$PSScriptRoot\cldctrl.ps1`"" -WindowStyle Hidden
Start-Sleep -Seconds 3
Get-Content (Join-Path $PSScriptRoot "debug.log")
