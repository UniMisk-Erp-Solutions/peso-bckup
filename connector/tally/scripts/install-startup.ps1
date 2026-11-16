# Deprecated name — use install-connector-production.ps1
param(
  [Parameter(Mandatory = $true)]
  [string]$ExePath
)
& "$PSScriptRoot/install-connector-production.ps1" -ExePath $ExePath
