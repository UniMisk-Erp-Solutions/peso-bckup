# Full MicroLink Sync→Tally bootstrap (requires Coolify SSH once).
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

$passFile = Join-Path $Root ".local-sensitive-data\coolify_ssh_password.txt"
if (-not (Test-Path $passFile)) {
  Write-Host "MISSING: $passFile"
  Write-Host "Create that file with one line: hasto SSH password for 192.168.23.46"
  exit 2
}

Write-Host "=== Deploy edge (job_batches + e2e) ==="
node scripts/tally-integration/deploy-e2e-controlled-stack.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "=== Pair Agent to MicroLink ==="
$env:ISSUE_PAIRING_CONFIRM = "1"
$env:PESO_TALLY_COMPANY = if ($env:PESO_TALLY_COMPANY) { $env:PESO_TALLY_COMPANY } else { "MicroLink" }
node scripts/tally-integration/ssh-issue-microlink-pairing-code.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "=== Start bridge + Vite ==="
& (Join-Path $Root "scripts\dev-microlink-tally-stack.ps1")
