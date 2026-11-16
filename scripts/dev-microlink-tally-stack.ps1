# One window: local app + automatic Tally delivery bridge (no prompts between Sync and Tally).
# Prerequisite: Agent paired to the org you sync (MicroLink) + Tally company in UI saved once.
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$Exe = Join-Path $Root "connector\tally\dist\PesoWise-Tally-Agent.exe"
if (-not (Test-Path $Exe)) {
  Push-Location (Join-Path $Root "connector\tally")
  npm.cmd run package:win
  Pop-Location
}

Write-Host "Starting Tally local bridge (127.0.0.1:9876) ..."
Start-Process -FilePath $Exe -ArgumentList "serve" -WindowStyle Minimized

Write-Host "Starting Vite http://localhost:3000 ..."
npm.cmd run dev
