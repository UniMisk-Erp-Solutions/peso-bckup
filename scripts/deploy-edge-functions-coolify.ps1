# Deploy supabase/functions to a self-hosted Supabase (Coolify) edge-runtime volume.
#
# Requires OpenSSH client (scp + ssh) and access to the Coolify host.
#
# .env (or shell):
#   COOLIFY_SSH=root@YOUR_SERVER_IP
#   COOLIFY_FUNCTIONS_PATH=/data/coolify/services/YOUR_SERVICE_ID/volumes/functions
#
# Usage:
#   npm run deploy:edge-functions
#   powershell -File scripts/deploy-edge-functions-coolify.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LocalFunctions = Join-Path $RepoRoot "supabase\functions"

function Load-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $parts = $_ -split '=', 2
    $key = $parts[0].Trim()
    $val = $parts[1].Trim().Trim('"').Trim("'")
    if ($key -and -not [string]::IsNullOrWhiteSpace($val) -and -not (Get-Item "Env:$key" -ErrorAction SilentlyContinue)) {
      Set-Item -Path "Env:$key" -Value $val
    }
  }
}

Load-DotEnv (Join-Path $RepoRoot ".env")

$ssh = $env:COOLIFY_SSH
$remotePath = $env:COOLIFY_FUNCTIONS_PATH

if (-not $ssh -or -not $remotePath) {
  Write-Host @"

COOLIFY_SSH and COOLIFY_FUNCTIONS_PATH are required in .env

Example:
  COOLIFY_SSH=root@203.0.113.10
  COOLIFY_FUNCTIONS_PATH=/data/coolify/services/abc123/volumes/functions

Find the path on the server:
  ls /data/coolify/services/*/volumes/functions/hello

See docs/coolify-edge-functions-deploy.md

"@ -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $LocalFunctions)) {
  throw "Missing local functions folder: $LocalFunctions"
}

Write-Host "Syncing edge functions to $ssh`:$remotePath ..." -ForegroundColor Cyan

# Preserve Coolify sample hello/main — sync each function folder individually.
$entries = Get-ChildItem -Path $LocalFunctions -Directory
foreach ($dir in $entries) {
  if ($dir.Name -in @("main", "hello")) { continue }
  $dest = "$remotePath/$($dir.Name)"
  Write-Host "  -> $($dir.Name)" -ForegroundColor Gray
  & ssh $ssh "mkdir -p `"$dest`""
  & scp -r "$($dir.FullName)\*" "${ssh}:${dest}/"
}

# _shared is required by admin-create-user and others.
$shared = Join-Path $LocalFunctions "_shared"
if (Test-Path $shared) {
  Write-Host "  -> _shared" -ForegroundColor Gray
  & ssh $ssh "mkdir -p `"$remotePath/_shared`""
  & scp -r "$shared\*" "${ssh}:${remotePath}/_shared/"
}

Write-Host "Restarting edge-runtime container ..." -ForegroundColor Cyan
& ssh $ssh "docker ps --format '{{.Names}}' | grep -E 'edge-functions|supabase-edge-functions' | head -1 | xargs -r docker restart"

Write-Host "Done. Verify bulk-users-import:" -ForegroundColor Green
Write-Host "  curl -X POST `"$($env:VITE_SUPABASE_URL)/functions/v1/bulk-users-import`" -H apikey:... -d '{`"rows`":[]}'"
