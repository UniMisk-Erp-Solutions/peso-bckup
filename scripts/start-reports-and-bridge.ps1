# Keep this window open while testing Reports -> Sync to Tally (starts bridge + Vite).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$Exe = Join-Path $Root "connector\tally\dist\PesoWise-Tally-Agent.exe"
if (-not (Test-Path $Exe)) {
  Write-Host "Building agent..."
  Push-Location (Join-Path $Root "connector\tally")
  npm.cmd run package:win
  Pop-Location
}

Write-Host "Starting Tally bridge (127.0.0.1:9876)..."
Start-Process -FilePath $Exe -ArgumentList "serve" -WindowStyle Minimized

Write-Host ""
Write-Host "Starting Vite - DO NOT CLOSE THIS WINDOW while testing."
Write-Host "Reports: http://localhost:3000/admin/reports"
Write-Host "Tally company in UI: PesoWise Integration Test (must match TallyPrime on this PC)."
Write-Host ""
npm.cmd run dev
