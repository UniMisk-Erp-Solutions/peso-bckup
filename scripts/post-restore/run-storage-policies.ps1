# Apply storage.objects RLS policies via psql (Direct connection required).
# SQL Editor cannot SET ROLE supabase_storage_admin on hosted Supabase.
#
# Usage:
#   npm run post-restore:storage-policies
#
# .env:
#   DATABASE_DIRECT_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.kqlqirdneocivumdjtvx.supabase.co:5432/postgres

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$SqlFile = Join-Path $PSScriptRoot "290529_1201_storage_policies_direct_connection.sql"

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
    throw "Database URL format not recognized."
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

$dbUrl = $env:DATABASE_DIRECT_URL
if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  $dbUrl = $env:DATABASE_URL
}

if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  throw @"
DATABASE_DIRECT_URL (or DATABASE_URL) is missing in .env.

Add the **Direct** connection string from Supabase Dashboard:
  Project Settings → Database → Connection string → Direct → URI

Example:
  DATABASE_DIRECT_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.kqlqirdneocivumdjtvx.supabase.co:5432/postgres

Do NOT use the Transaction pooler host for storage policy DDL.
"@
}

if ($dbUrl -match 'pooler\.supabase\.com') {
  Write-Warning "Your URL uses the pooler host. Storage policies need the Direct host: db.<project-ref>.supabase.co"
  Write-Warning "Update DATABASE_DIRECT_URL in .env and re-run."
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
Write-Host "=== Storage policies (direct connection) ===" -ForegroundColor Cyan
Write-Host "File: $SqlFile"
Write-Host "Host: $($db.Host)"
Write-Host ""

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql not found. Install PostgreSQL client tools or run the SQL file via Supabase CLI: supabase db execute --file `"$SqlFile`""
}

& psql "-v" "ON_ERROR_STOP=1" "-f" $SqlFile
if ($LASTEXITCODE -ne 0) {
  throw "psql failed (exit $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Storage policies applied. Run 290529_1202_verify_after_safe_restore.sql in SQL Editor." -ForegroundColor Green
