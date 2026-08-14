# Fix GoTrue "Database error querying schema" (NULL token columns in auth.users).
# Required after restoring auth.users from a cloud backup onto self-hosted Supabase.
#
# Usage:
#   npm run post-restore:auth-null-tokens
#
# .env (pick one — self-hosted Coolify Postgres URI preferred):
#   COOLIFY_DATABASE_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@HOST:5432/postgres
#   DATABASE_DIRECT_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.<ref>.supabase.co:5432/postgres
#   DATABASE_URL=postgresql://...

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$SqlFile = Join-Path $PSScriptRoot "090606_1600_fix_auth_users_null_tokens.sql"

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

$dbUrl = $env:COOLIFY_DATABASE_URL
if ([string]::IsNullOrWhiteSpace($dbUrl)) { $dbUrl = $env:DATABASE_DIRECT_URL }
if ([string]::IsNullOrWhiteSpace($dbUrl)) { $dbUrl = $env:DATABASE_URL }

if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  throw @"
COOLIFY_DATABASE_URL (or DATABASE_DIRECT_URL / DATABASE_URL) is missing in .env.

For self-hosted Supabase on Coolify, copy the Postgres URI from Coolify → your Supabase stack → Postgres service, then set:

  COOLIFY_DATABASE_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@HOST:5432/postgres

Then re-run: npm run post-restore:auth-null-tokens
"@
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

if ($dbUrl -match 'pooler\.supabase\.com' -and -not $env:COOLIFY_DATABASE_URL) {
  Write-Warning "Using Supabase cloud pooler. For self-hosted Coolify login fix, set COOLIFY_DATABASE_URL in .env."
}
Write-Host "File: $SqlFile"
Write-Host "Host: $($db.Host)"
Write-Host ""

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
  throw "psql not found. Install PostgreSQL client tools or paste the SQL into Coolify / Supabase SQL editor."
}

Write-Host "Checking NULL token columns before fix..." -ForegroundColor DarkGray
& psql "-t" "-A" "-c" @"
SELECT COUNT(*) FROM auth.users
WHERE confirmation_token IS NULL
   OR recovery_token IS NULL
   OR email_change_token_new IS NULL
   OR email_change IS NULL
   OR email_change_token_current IS NULL;
"@
if ($LASTEXITCODE -ne 0) {
  throw "Could not query auth.users. Verify COOLIFY_DATABASE_URL points at your self-hosted Postgres."
}

& psql "-v" "ON_ERROR_STOP=1" "-f" $SqlFile
if ($LASTEXITCODE -ne 0) {
  throw "psql failed (exit $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Auth token columns fixed. Retry login against your VITE_SUPABASE_URL." -ForegroundColor Green
