# Applies every supabase/migrations/*.sql file first added to git AFTER 2026-05-27 05:30:00,
# in filename order, then scripts/post-restore/01-after-backup-restore.sql (grants + URL rewrite).
#
# Usage: npm run post-restore:migrations

param(
  [switch]$MigrationsOnly,
  [switch]$SkipExtras
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$MigrationsDir = Join-Path $ProjectRoot "supabase\migrations"
$ExtrasSql = Join-Path $PSScriptRoot "01-after-backup-restore.sql"

$migrationFiles = @(
  "20260524180000_expense_hierarchy_review_select_expand.sql",
  "20260524190000_list_organizations_for_dev_login.sql",
  "20260524190100_fix_dev_tenant_list_use_slug.sql",
  "20260524200000_tl_executive_expense_submit_and_select.sql",
  "20260524210000_list_hierarchy_reviewer_expenses_rpc.sql",
  "20260524220000_fix_hierarchy_reviewer_act_permissions.sql",
  "20260524230000_fix_hierarchy_verify_advance.sql",
  "20260524240000_hierarchy_tl_verify_fix.sql",
  "20260524250000_hierarchy_verification_statuses.sql",
  "20260524250100_hierarchy_verification_statuses_apply.sql",
  "20260524260000_fix_hierarchy_verify_status_by_role.sql",
  "20260524270000_backfill_level2_queue_after_tl_verify.sql",
  "20260524280000_manager_review_queue_and_managing_engineer.sql",
  "20260524290000_expand_manager_team_visibility.sql",
  "20260524300000_fix_level2_verified_manager_queue.sql",
  "20260524310000_executive_handoff_to_manager_level2.sql",
  "20260524320000_manager_sees_stuck_executive_queue.sql",
  "20260524330000_manager_verify_auto_repair.sql",
  "20260528183500_manager_visibility_stable_rpc.sql",
  "20260530120000_fix_public_schema_grants_after_restore.sql"
)

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
    throw "DATABASE_URL format not recognized."
  }
  return @{
    User     = [uri]::UnescapeDataString($matches[1])
    Password = [uri]::UnescapeDataString($matches[2])
    Host     = $matches[3]
    Port     = if ($matches[4]) { $matches[4] } else { "5432" }
    Database = $matches[5]
  }
}

function Invoke-SqlFile {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path $Path)) {
    throw "Missing SQL file: $Path"
  }
  Write-Host ""
  Write-Host ">>> $Label" -ForegroundColor Cyan
  Write-Host "    $Path" -ForegroundColor DarkGray
  & psql "-v" "ON_ERROR_STOP=1" "-f" $Path
  if ($LASTEXITCODE -ne 0) {
    throw "Failed: $Label (exit $LASTEXITCODE)"
  }
}

Load-DotEnv (Join-Path $ProjectRoot ".env.local")
Load-DotEnv (Join-Path $ProjectRoot ".env")

$dbUrl = $env:DATABASE_URL
if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  throw "Set DATABASE_URL in .env"
}

$db = Parse-DatabaseUrl $dbUrl
$env:PGHOST = $db.Host
$env:PGPORT = $db.Port
$env:PGUSER = $db.User
$env:PGPASSWORD = $db.Password
$env:PGDATABASE = $db.Database
$env:PGSSLMODE = "require"

Write-Host "Post-backup migrations (after 2026-05-27 05:30)" -ForegroundColor Yellow
Write-Host "Host: $($db.Host)"
Write-Host "Count: $($migrationFiles.Count) migration files" -ForegroundColor Yellow

$i = 0
foreach ($name in $migrationFiles) {
  $i++
  $path = Join-Path $MigrationsDir $name
  Invoke-SqlFile -Path $path -Label "[$i/$($migrationFiles.Count)] $name"
}

if (-not $SkipExtras) {
  Invoke-SqlFile -Path $ExtrasSql -Label "Extras (grants + URL rewrite + verify)"
}

Write-Host ""
Write-Host "All migration SQL completed." -ForegroundColor Green
if (-not $MigrationsOnly) {
  Write-Host "Optional: npm run post-restore:storage" -ForegroundColor DarkYellow
}
