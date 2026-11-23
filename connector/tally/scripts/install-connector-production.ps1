# Register PesoWiseConnector for background sync at user logon (no admin required).
param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)
$exe = Resolve-Path $ExePath
if (-not (Test-Path $exe)) {
  Write-Error "Exe not found: $ExePath"
  exit 1
}
$action = New-ScheduledTaskAction -Execute $exe.Path -Argument "run"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "PesoWiseConnector" -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Registered scheduled task PesoWiseConnector -> $($exe.Path) run"
Write-Host "Logs: $env:USERPROFILE\PesoWise\TallyConnector\connector.log"
Write-Host "Health: $env:USERPROFILE\PesoWise\TallyConnector\health.json"
