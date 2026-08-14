# Full logical Supabase database backup (READ-ONLY — does not modify or delete live data).
#
# Uses native pg_dump / pg_dumpall (no Docker, no supabase CLI required).
#
# Creates:
#   roles.sql       — cluster roles (pg_dumpall -r)
#   schema.sql      — public schema structure + RLS
#   data.sql        — public schema row data
#   full_backup.sql — entire database (auth.users, storage metadata, etc.)
#
# Usage:
#   npm run backup:full
#   powershell -ExecutionPolicy Bypass -File scripts/full-local-backup.ps1 -OutDir "D:\backups\supabase_backup_2026-05-29"

param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path $PSScriptRoot -Parent

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
    throw "DATABASE_URL format not recognized. Use Session pooler URI from Supabase Dashboard."
  }
  return @{
    User = [uri]::UnescapeDataString($matches[1])
    Password = [uri]::UnescapeDataString($matches[2])
    Host = $matches[3]
    Port = if ($matches[4]) { $matches[4] } else { "5432" }
    Database = $matches[5]
  }
}

function Test-DatabaseConnection {
  param($Db)
  $env:PGHOST = $Db.Host
  $env:PGPORT = $Db.Port
  $env:PGUSER = $Db.User
  $env:PGPASSWORD = $Db.Password
  $env:PGDATABASE = $Db.Database
  $env:PGSSLMODE = "require"
  $null = & psql "-c" "SELECT 1" 2>&1
  return $LASTEXITCODE -eq 0
}

Load-DotEnv (Join-Path $ProjectRoot ".env")
Load-DotEnv (Join-Path $ProjectRoot ".env.local")

$dbUrl = $env:DATABASE_URL
if (-not $dbUrl) {
  Write-Host "ERROR: DATABASE_URL is not set in .env" -ForegroundColor Red
  Write-Host "Dashboard -> Project Settings -> Database -> Connection string (URI, port 5432 direct)." -ForegroundColor Yellow
  exit 1
}

$liveRef = $env:VITE_SUPABASE_PROJECT_ID
if ($liveRef -and $dbUrl -notmatch [regex]::Escape($liveRef)) {
  Write-Host "WARNING: DATABASE_URL does not match VITE_SUPABASE_PROJECT_ID ($liveRef)." -ForegroundColor Yellow
  $confirm = Read-Host "Continue anyway? (y/N)"
  if ($confirm -notmatch '^[yY]') { exit 1 }
}

if (-not $OutDir) {
  $dateStamp = Get-Date -Format "yyyy-MM-dd"
  $parent = Split-Path $ProjectRoot -Parent
  $OutDir = Join-Path $parent "supabase_backup_$dateStamp"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$rolesFile = Join-Path $OutDir "roles.sql"
$schemaFile = Join-Path $OutDir "schema.sql"
$dataFile = Join-Path $OutDir "data.sql"
$fullFile = Join-Path $OutDir "full_backup.sql"
$manifestFile = Join-Path $OutDir "BACKUP_MANIFEST.txt"

$db = Parse-DatabaseUrl $dbUrl

$psql = Get-Command psql -ErrorAction SilentlyContinue
if ($psql -and -not (Test-DatabaseConnection $db)) {
  Write-Host ""
  Write-Host "ERROR: Cannot connect with DATABASE_URL." -ForegroundColor Red
  Write-Host "If password contains ! # @ etc., URL-encode it in DATABASE_URL (e.g. ! -> %21)." -ForegroundColor Yellow
  Write-Host "Meanwhile: npm run backup:full:api" -ForegroundColor Cyan
  exit 1
}

$env:PGHOST = $db.Host
$env:PGPORT = $db.Port
$env:PGUSER = $db.User
$env:PGPASSWORD = $db.Password
$env:PGDATABASE = $db.Database
$env:PGSSLMODE = "require"

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
$pgDumpAll = Get-Command pg_dumpall -ErrorAction SilentlyContinue
if (-not $pgDump) {
  Write-Host "ERROR: pg_dump not found. Install PostgreSQL client tools." -ForegroundColor Red
  exit 1
}
if (-not $pgDumpAll) {
  Write-Host "ERROR: pg_dumpall not found. Install PostgreSQL client tools." -ForegroundColor Red
  exit 1
}

$connAll = @()
$conn = @()

Write-Host ""
Write-Host "=== Supabase full local backup (read-only) ===" -ForegroundColor Cyan
Write-Host "Host: $($db.Host)"
Write-Host "Output: $OutDir"
Write-Host ""

Write-Host "[1/4] Dumping roles.sql (pg_dumpall -r) ..." -ForegroundColor Green
& pg_dumpall @connAll "-r" "--no-role-passwords" "-f" $rolesFile
if ($LASTEXITCODE -ne 0) { throw "pg_dumpall (roles) failed with exit $LASTEXITCODE" }

Write-Host "[2/4] Dumping schema.sql (public) ..." -ForegroundColor Green
& pg_dump @conn "--schema-only" "--no-owner" "--no-privileges" "--schema=public" "-f" $schemaFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump (schema) failed with exit $LASTEXITCODE" }

Write-Host "[3/4] Dumping data.sql (public) ..." -ForegroundColor Green
& pg_dump @conn "--data-only" "--no-owner" "--no-privileges" "--schema=public" "-f" $dataFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump (data) failed with exit $LASTEXITCODE" }

Write-Host "[4/4] Dumping full_backup.sql (all schemas) ..." -ForegroundColor Green
# DROP statements are inside the file for future restore only — live DB is not modified.
& pg_dump @conn "--clean" "--if-exists" "--no-owner" "--no-privileges" "-f" $fullFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump (full) failed with exit $LASTEXITCODE" }

$manifest = @"
Supabase backup manifest
Created: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
Host: $($db.Host)
Database: $($db.Database)
Live app ref (VITE_SUPABASE_PROJECT_ID): $liveRef

Files:
  roles.sql       - cluster roles
  schema.sql      - public schema structure + RLS
  data.sql        - public schema row data
  full_backup.sql - entire database (auth.users, storage.objects metadata, etc.)

IMPORTANT:
  - READ-ONLY copy. Nothing was deleted on Supabase.
  - SQL dumps do NOT include Storage bucket file bytes.
  - Run: npm run backup:storage  (needs SUPABASE_SERVICE_ROLE_KEY in .env)
  - Keep this folder private. Rotate keys if ever exposed.
"@

Set-Content -Path $manifestFile -Value $manifest -Encoding UTF8

Write-Host ""
Write-Host "Done. Backup saved to:" -ForegroundColor Green
Write-Host "  $OutDir"
Get-ChildItem $OutDir | ForEach-Object {
  $sizeMb = [math]::Round($_.Length / 1MB, 2)
  Write-Host ("  {0,-20} {1,8} MB" -f $_.Name, $sizeMb)
}
Write-Host ""
Write-Host "Next: npm run backup:storage" -ForegroundColor Cyan
