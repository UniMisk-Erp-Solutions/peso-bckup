$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$entryPoint = (Resolve-Path (Join-Path $workspaceRoot "connector\tally\dist\main.js")).Path
$nodePath = "C:\Program Files\nodejs\node.exe"
$healthUrl = "http://127.0.0.1:9876/v1/health"
$expectedCompany = "PesoWise Integration Test"

if (-not (Test-Path -LiteralPath $nodePath)) {
  throw "Node.js was not found at the expected local path: $nodePath"
}

try {
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if ($health.delivery_in_progress) {
    throw "A Tally delivery is in progress. Wait for it to finish before restarting the PesoWise bridge."
  }
  if (-not $health.connector_paired -or $health.tally_company_verified_name -ne $expectedCompany) {
    throw "The existing bridge is not paired and verified for $expectedCompany. No process was stopped."
  }
} catch {
  if ($_.Exception.Message -match "delivery is in progress|not paired and verified") { throw }
  # The bridge may already be stopped; start it below after checking the port.
}

$listeners = @(Get-NetTCPConnection -LocalPort 9876 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 1) {
  throw "More than one process is listening on the PesoWise local bridge port. No process was stopped."
}

if ($listeners.Count -eq 1) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)"
  if ($process.ExecutablePath -ne $nodePath -or $process.CommandLine -notmatch "connector[/\\]tally[/\\]dist[/\\]main\.js") {
    throw "Port 9876 is not owned by the expected PesoWise connector entrypoint. No process was stopped."
  }
  Stop-Process -Id $process.ProcessId -Force
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-NetTCPConnection -LocalPort 9876 -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-NetTCPConnection -LocalPort 9876 -State Listen -ErrorAction SilentlyContinue) {
    throw "The previous PesoWise bridge did not release port 9876."
  }
}

Start-Process -FilePath $nodePath -ArgumentList @($entryPoint, "run") `
  -WorkingDirectory $workspaceRoot -WindowStyle Hidden | Out-Null

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($health.service -eq "pesowise-tally-bridge" -and $health.connector_paired `
      -and $health.tally_company_verified_name -eq $expectedCompany) {
      $health | Select-Object service, connector_paired, tally_reachable, `
        tally_company_verified_name, metadata_import_ready, delivery_in_progress | Format-List
      exit 0
    }
  } catch { }
}

throw "The PesoWise local bridge did not become healthy. Check %USERPROFILE%\PesoWise\TallyConnector\connector.log."
