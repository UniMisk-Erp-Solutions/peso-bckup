# The Inno uninstaller runs elevated, but its [UninstallRun] section cannot
# impersonate the original installer user. Remove only this connector's known
# files from Windows user profiles and its URL handler in already-loaded hives.
$ErrorActionPreference = "Stop"
$profiles = Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath -and $_.SID }
foreach ($profile in $profiles) {
  $userData = Join-Path $profile.LocalPath "PesoWise\TallyConnector"
  if (Test-Path -LiteralPath $userData -PathType Container) {
    foreach ($name in @("config.json", "connector.log")) {
      $file = Join-Path $userData $name
      if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
    }
    if (@(Get-ChildItem -LiteralPath $userData -Force -ErrorAction SilentlyContinue).Count -eq 0) {
      Remove-Item -LiteralPath $userData -Force
    }
  }

  # Do not load/unload another user's registry hive during uninstall. A loaded
  # profile is safe to clean directly; an unloaded profile's stale protocol
  # entry only points to the removed installation and contains no token.
  $protocol = "Registry::HKEY_USERS\$($profile.SID)\Software\Classes\pesowise-tally"
  if (Test-Path -LiteralPath $protocol) {
    Remove-Item -LiteralPath $protocol -Recurse -Force
  }
}
Write-Output "Removed PesoWise local pairing state for installed Windows profiles. Revoke the connector in PesoWise Admin to invalidate its server token immediately."
