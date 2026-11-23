# Pair Tally Agent to ANY org (pairing code must be for that org).
# Env: PESO_PAIRING_CODE (required), PESO_TALLY_COMPANY (exact TallyPrime company name)
# Optional: PESO_TALLY_ANON_KEY or Coolify SSH for resolve-backup-anon-key.mjs
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
if (-not $env:PESO_PAIRING_CODE) { throw "Set PESO_PAIRING_CODE (create via admin RPC or create-connector-pairing-code.mjs)" }
$company = $env:PESO_TALLY_COMPANY
if (-not $company) { throw "Set PESO_TALLY_COMPANY to the exact TallyPrime company name for this org" }
if (-not $env:PESO_TALLY_ANON_KEY) {
  $bundleOut = node -e "import('./scripts/tally-integration/_loadBackupAnonKey.mjs').then(m=>m.loadBackupAnonKey().then(k=>process.stdout.write(k)))" 2>&1 | Out-String
  if ($bundleOut -match '(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)') {
    $env:PESO_TALLY_ANON_KEY = $Matches[1]
  }
}
if (-not $env:PESO_TALLY_ANON_KEY) { throw "Set PESO_TALLY_ANON_KEY" }
& ".\connector\tally\dist\PesoWise-Tally-Agent.exe" pair `
  --url "https://pesowise-backup-supabase.unimisk.com" `
  --anon-key $env:PESO_TALLY_ANON_KEY `
  --code $env:PESO_PAIRING_CODE `
  --company $company
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Paired. Start delivery: .\scripts\run-tally-agent-dev.ps1"
