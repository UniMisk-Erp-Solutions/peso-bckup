# PesoWise-Tally-Setup: per-user install (no admin rights). Idempotent: safe to run again to re-pair/upgrade.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Programs\PesoWiseTally'
$cfg  = Get-Content (Join-Path $src 'setup-config.json') -Raw | ConvertFrom-Json
$exe  = Join-Path $dest 'PesoWiseTally.exe'

function Say($m, $t = 'PesoWise Tally Setup', $icon = 'Information') {
  [void][System.Windows.Forms.MessageBox]::Show($m, $t, 'OK', $icon)
}

# 1) Stop a running copy, then copy files.
Get-Process -Name 'PesoWiseTally' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src 'PesoWiseTally.exe') $exe -Force
Copy-Item (Join-Path $src 'PesoWise-Tally.tdl') (Join-Path $dest 'PesoWise-Tally.tdl') -Force
Copy-Item (Join-Path $src 'install.ps1') (Join-Path $dest 'install.ps1') -Force

# 2) Pair (skipped when already paired and the user chooses to keep it).
$paired = Test-Path (Join-Path $env:LOCALAPPDATA 'PesoWise\TallyConnector\config.json')
$doPair = $true
if ($paired) {
  $a = [System.Windows.Forms.MessageBox]::Show(("This PC is already paired with PesoWise.`n`nYes = pair again with a NEW code (use this to change company or organisation).`nNo = keep the current pairing; the connector is simply updated and restarted."), 'PesoWise Tally Setup', 'YesNo', 'Question')
  $doPair = ($a -eq 'Yes')
}
if ($doPair) {
  $code = [Microsoft.VisualBasic.Interaction]::InputBox("Enter the pairing code shown in PesoWise (Admin > Tally connector).`n`nAuthorised server: $($cfg.apiBase)", 'PesoWise pairing code', '')
  if ([string]::IsNullOrWhiteSpace($code)) { Say 'No code entered. Setup stopped; run it again when you have a code.' 'PesoWise Tally Setup' 'Warning'; exit 1 }
  $pairArgs = @('pair', '--api', $cfg.apiBase, '--code', $code.Trim())
  if ($cfg.apiKey) { $pairArgs += @('--key', $cfg.apiKey) }
  if ($cfg.tallyUrl) { $pairArgs += @('--tally-url', $cfg.tallyUrl) }
  & $exe @pairArgs
  if ($LASTEXITCODE -ne 0) { Say 'Pairing failed. The code may be wrong or expired (15 minutes). See %LOCALAPPDATA%\PesoWise\TallyConnector\connector.log' 'PesoWise Tally Setup' 'Error'; exit 1 }
}

# 3) Background start at logon (hidden) + start now.
& $exe 'install-startup'
# Start it now, hidden, in this user session (outside the packaged exe). The logon entry covers every later sign-in.
$vbs = Join-Path $env:LOCALAPPDATA 'PesoWise\TallyConnector\run-hidden.vbs'
Get-Process -Name 'PesoWiseTally' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-Process -WindowStyle Hidden -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"')
$running = $false
for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 1; if (Get-Process -Name 'PesoWiseTally' -ErrorAction SilentlyContinue) { $running = $true; break } }

# 4) Report health.
Start-Sleep -Seconds 3
$report = (& $exe 'doctor' 2>&1 | Out-String)
$state = if ($running) { 'Connector is RUNNING.' } else { 'WARNING: the connector did not start. Sign out and in again, or see %LOCALAPPDATA%\PesoWise\TallyConnector\connector.log' }
Say ("Installed to $dest`n$state`n`n$report`nNext, in TallyPrime:`n1. F1 (Help) > Settings > Connectivity > Client/Server configuration: enable ODBC/HTTP on the port above.`n2. F1 > TDL & Add-On > Load TDL: $dest\PesoWise-Tally.tdl`n3. Open the authorised company, then use Sync to Tally in PesoWise.")
