# Priyanshu HA — full local E2E (Windows). Does NOT push or touch production.
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Write-Host "Priyanshu HA local E2E — repo: $RepoRoot"
Write-Host "No push, no production servers."
Set-Location $RepoRoot
node scripts/ha/lab/ha-e2e.mjs
exit $LASTEXITCODE
