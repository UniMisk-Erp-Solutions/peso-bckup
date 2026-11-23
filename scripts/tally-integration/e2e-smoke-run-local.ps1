# End-to-end smoke transport on THIS PC (paired agent + Tally on 9000).
# Optional: TALLY_VALIDATE_ADMIN_* to trigger Daily Project sync without UI.
# Optional: DEPLOY_SSH_PASSWORD for remote queue verify only.
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

Write-Host "=== pairing RPC probe ==="
node scripts/tally-integration/probe-pairing-rpc.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($env:DEPLOY_SSH_PASSWORD) {
  Write-Host "=== remote queue safe ==="
  node scripts/tally-integration/ssh-verify-queue-safe.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$AgentExe = Join-Path $Root "connector\tally\dist\PesoWise-Tally-Agent.exe"
if (-not (Test-Path $AgentExe)) {
  Write-Host "=== build Agent EXE ==="
  Push-Location connector/tally
  npm.cmd run package:win
  Pop-Location
}

# Do not launch TallyPrime — use your already-running instance (integration on 127.0.0.1:9000).
Write-Host "=== doctor (127.0.0.1:9000 + configured company context) ==="
& $AgentExe doctor
if ($LASTEXITCODE -ne 0) {
  Write-Host "STOP: doctor failed. Keep existing TallyPrime running; confirm ODBC/HTTP on port 9000 and company name in agent config."
  exit 1
}

if ($env:TALLY_VALIDATE_ADMIN_EMAIL -and $env:TALLY_VALIDATE_ADMIN_PASSWORD) {
  Write-Host "=== trigger Daily Project sync (API) ==="
  node scripts/tally-integration/trigger-smoke-daily-sync.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "SKIP sync trigger - set TALLY_VALIDATE_ADMIN_EMAIL/PASSWORD or click Sync once in smoke org admin UI."
}

if ($env:E2E_SKIP_AGENT_RUN) {
  Write-Host "E2E_SKIP_AGENT_RUN set - stopping before agent run loop."
  exit 0
}
Write-Host '=== agent run (Ctrl+C after job completes) ==='
& $AgentExe run
