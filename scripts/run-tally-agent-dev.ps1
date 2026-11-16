# Keep Tally Agent running while testing Reports → Sync to Tally (localhost or Vercel).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Exe = Join-Path $Root "connector\tally\dist\PesoWise-Tally-Agent.exe"
if (-not (Test-Path $Exe)) {
  Push-Location (Join-Path $Root "connector\tally")
  npm.cmd run package:win
  Pop-Location
}
Write-Host "Tally Agent run loop — Ctrl+C to stop. TallyPrime must listen on 127.0.0.1:9000."
& $Exe run
