# Install winget (App Installer)
Write-Host "Installing winget (App Installer)..." -ForegroundColor Cyan
$wingetInstaller = "$env:TEMP\Microsoft.DesktopAppInstaller.msixbundle"
Invoke-WebRequest -Uri "https://aka.ms/getwinget" -OutFile $wingetInstaller
Add-AppxPackage $wingetInstaller -ErrorAction SilentlyContinue
Write-Host "winget installed." -ForegroundColor Green

# Install Tailscale
Write-Host "Installing Tailscale..." -ForegroundColor Cyan
$installer = "$env:TEMP\tailscale-setup.exe"
Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe" -OutFile $installer
Start-Process $installer -Wait
Write-Host "Opening Tailscale install location..." -ForegroundColor Green
explorer "C:\Program Files\Tailscale"
