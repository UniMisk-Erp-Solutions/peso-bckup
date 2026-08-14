# Run all post-backup-restore fixes from your PC.
#
# 1. Applies scripts/post-restore/01-after-backup-restore.sql via psql (needs DATABASE_URL in .env)
# 2. Optionally uploads receipt files from local backup (npm run post-restore:storage)
#
# Usage:
#   npm run post-restore:all
#   npm run post-restore:sql
#   npm run post-restore:storage
#
#   powershell -ExecutionPolicy Bypass -File scripts/post-restore/run-after-backup-restore.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/post-restore/run-after-backup-restore.ps1 -SqlOnly
#   powershell -ExecutionPolicy Bypass -File scripts/post-restore/run-after-backup-restore.ps1 -StorageOnly

param(
  [switch]$SqlOnly,
  [switch]$StorageOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$SqlFile = Join-Path $PSScriptRoot "01-after-backup-restore.sql"

function Load-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $key = $matches[1].Trim()
      $val = $matches[2].Trim() -replace '^["'']|["'']$'
      if (-not [string]::IsNullOrWhiteSpace($key)) {
        Set-Item -Path "Env:$key" -Value $val
      }
    }
  }
}

function Parse-DatabaseUrl {
  param([string]$Url)
  if ($Url -notmatch '^postgresql://([^:***REMOVED-SENSITIVE-VALUE***@]+)@([^:/]+)(?::(\d+))?/([^?]+)') {
    throw "DATABASE_URL format not recognized. Use the Session pooler URI from Supabase Dashboard."
  }
  return @{
    User     = [uri]::UnescapeDataString($matches[1])
    Password = [uri]::UnescapeDataString($matches[2])
    Host     = $matches[3]
    Port     = if ($matches[4]) { $matches[4] } else { "5432" }
    Database = $matches[5]
  }
}

Load-DotEnv (Join-Path $ProjectRoot ".env.local")
Load-DotEnv (Join-Path $ProjectRoot ".env")

function Run-SqlRestore {
  $dbUrl = $env:DATABASE_URL
  if ([string]::IsNullOrWhiteSpace($dbUrl)) {
    throw "DATABASE_URL is not set in .env — add your Supabase pooler connection string."
  }
  if (-not (Test-Path $SqlFile)) {
    throw "Missing SQL file: $SqlFile"
  }

  $db = Parse-DatabaseUrl $dbUrl
  $env:PGHOST = $db.Host
  $env:PGPORT = $db.Port
  $env:PGUSER = $db.User
  $env:PGPASSWORD = $db.Password
  $env:PGDATABASE = $db.Database
  $env:PGSSLMODE = "require"

  Write-Host ""
  Write-Host "=== Running post-restore SQL ===" -ForegroundColor Cyan
  Write-Host "File: $SqlFile"
  Write-Host "Host: $($db.Host)"
  Write-Host ""

  & psql "-v" "ON_ERROR_STOP=1" "-f" $SqlFile
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed (exit $LASTEXITCODE). Fix errors above or paste the SQL file into Supabase SQL Editor."
  }
  Write-Host ""
  Write-Host "SQL restore script completed." -ForegroundColor Green
}

function Run-StorageRestore {
  Write-Host ""
  Write-Host "=== Uploading receipt files to Storage ===" -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try {
    npm run post-restore:storage
    if ($LASTEXITCODE -ne 0) { throw "Storage upload failed (exit $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
  Write-Host "Storage upload completed." -ForegroundColor Green
}

Write-Host "PesoWise post-backup-restore" -ForegroundColor Yellow
Write-Host "Project root: $ProjectRoot"

if (-not $StorageOnly) {
  $migrationsScript = Join-Path $PSScriptRoot "run-migrations-after-backup.ps1"
  if (Test-Path $migrationsScript) {
    Write-Host "Running all migrations after 2026-05-27 05:30..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File $migrationsScript -MigrationsOnly
    if ($LASTEXITCODE -ne 0) { throw "Migrations script failed." }
    Run-SqlRestore
  } else {
    Run-SqlRestore
  }
}

if (-not $SqlOnly) {
  Run-StorageRestore
}

Write-Host ""
Write-Host "All done. Redeploy Vercel if needed and confirm VITE_SUPABASE_* env vars match kqlqirdneocivumdjtvx." -ForegroundColor Green
