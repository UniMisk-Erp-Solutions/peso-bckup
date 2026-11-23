# Smoke-org E2E bootstrap (requires DEPLOY_SSH_PASSWORD in session; does not print service_role).
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
if (-not $env:DEPLOY_SSH_PASSWORD) { throw "Set DEPLOY_SSH_PASSWORD first" }

Write-Host "=== queue safe ==="
node scripts/tally-integration/ssh-verify-queue-safe.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "=== pairing state ==="
node scripts/tally-integration/ssh-inspect-test-pairing-state.mjs

Write-Host "=== pgcrypto search_path ==="
node scripts/tally-integration/apply-pgcrypto-search-path-only.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "=== anon key (backup Kong) ==="
$env:PRINT_ANON_KEY = "1"
node scripts/tally-integration/resolve-backup-anon-key.mjs | Tee-Object -Variable anonJson
Remove-Item Env:PRINT_ANON_KEY -ErrorAction SilentlyContinue

Write-Host "=== probe exchange RPC (expect not 401; invalid code OK) ==="
node scripts/tally-integration/probe-pairing-rpc.mjs

Write-Host "=== build Agent ==="
Push-Location connector/tally
npm run package:win
Pop-Location

Write-Host "DONE. Next: pair with stderr anon key + existing pairing code, then doctor, then ONE Daily Project Sync."
