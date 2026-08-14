# Database backup without Docker (uses pg_dump if available).
# Set DATABASE_URL in .env or in the environment. Get it from:
#   Supabase Dashboard -> Project Settings -> Database -> Connection string (URI)
#   Format: postgresql://postgres.[PROJECT-REF]:***REMOVED-SENSITIVE-VALUE***@aws-0-[REGION].pooler.supabase.com:6543/postgres

param([string]$OutFile = "backup.sql")

# Load .env from project root (parent of scripts/)
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $key = $matches[1].Trim()
      $val = $matches[2].Trim() -replace '^["'']|["'']$'
      Set-Item -Path "Env:$key" -Value $val
    }
  }
}

$dbUrl = $env:DATABASE_URL
if (-not $dbUrl) {
  Write-Host "ERROR: DATABASE_URL is not set." -ForegroundColor Red
  Write-Host "Add DATABASE_URL to your .env file with your Supabase connection string." -ForegroundColor Yellow
  Write-Host "Get it from: Supabase Dashboard -> Project Settings -> Database -> Connection string (URI)" -ForegroundColor Yellow
  Write-Host "Example: DATABASE_URL=postgresql://postgres.REF:***REMOVED-SENSITIVE-VALUE***@aws-0-REGION.pooler.supabase.com:6543/postgres" -ForegroundColor Gray
  exit 1
}

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  Write-Host "ERROR: pg_dump not found. Install PostgreSQL client tools (includes pg_dump):" -ForegroundColor Red
  Write-Host "  https://www.postgresql.org/download/windows/" -ForegroundColor Yellow
  Write-Host "Or use Docker: start Docker Desktop, then run: npx supabase db dump -f $OutFile" -ForegroundColor Yellow
  exit 1
}

& pg_dump "$dbUrl" --no-owner --no-privileges -f $OutFile 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "pg_dump failed (exit code $LASTEXITCODE). Check DATABASE_URL and network." -ForegroundColor Red
  exit $LASTEXITCODE
}
Write-Host "Dump saved to $OutFile" -ForegroundColor Green
