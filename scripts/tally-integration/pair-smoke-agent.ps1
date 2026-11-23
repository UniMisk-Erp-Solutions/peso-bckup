# Pair smoke org Agent (requires PESO_PAIRING_CODE + correct anon in PESO_TALLY_ANON_KEY).
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
if (-not $env:PESO_PAIRING_CODE) { throw "Set PESO_PAIRING_CODE to your existing one-time code" }
if (-not $env:PESO_TALLY_ANON_KEY) {
  if ($env:DEPLOY_SSH_PASSWORD) {
    $env:PRINT_ANON_KEY = "1"
    $resolveOut = node scripts/tally-integration/resolve-backup-anon-key.mjs 2>&1 | Out-String
    Remove-Item Env:PRINT_ANON_KEY -ErrorAction SilentlyContinue
    if ($resolveOut -match '(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)') {
      $env:PESO_TALLY_ANON_KEY = $Matches[1]
    }
  }
  if (-not $env:PESO_TALLY_ANON_KEY) {
    $bundleOut = node -e "import('./scripts/tally-integration/_loadBackupAnonKey.mjs').then(m=>m.loadBackupAnonKey().then(k=>process.stdout.write(k)))" 2>&1 | Out-String
    if ($bundleOut -match '(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)') {
      $env:PESO_TALLY_ANON_KEY = $Matches[1]
    }
  }
  if (-not $env:PESO_TALLY_ANON_KEY) { throw "Set PESO_TALLY_ANON_KEY, DEPLOY_SSH_PASSWORD, or ensure Vercel bundle anon resolves" }
}
& ".\connector\tally\dist\PesoWise-Tally-Agent.exe" pair `
  --url "https://pesowise-backup-supabase.unimisk.com" `
  --anon-key $env:PESO_TALLY_ANON_KEY `
  --code $env:PESO_PAIRING_CODE `
  --company "PesoWise Integration Test"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ".\connector\tally\dist\PesoWise-Tally-Agent.exe" doctor
