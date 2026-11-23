# Remove only PesoWise-owned Tally.ini entries and connector state. Preserve
# unrelated TDL entries, company data, Tally files, and any user-edited TDLs.
param([string]$TdlDir = "C:\pesowise")
$ErrorActionPreference = "Stop"
$statePath = Join-Path $env:ProgramData "PesoWise\TallyConnector\installer-state.json"
$managedNames = @("PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl")

function Write-PreservedText([string]$Path, [string]$Text) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $encoding = [Text.Encoding]::Default
  $bom = [byte[]]@()
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $encoding = [Text.UTF8Encoding]::new($true); $bom = [byte[]]@(0xEF,0xBB,0xBF)
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $encoding = [Text.UnicodeEncoding]::new($false, $true); $bom = [byte[]]@(0xFF,0xFE)
  }
  [IO.File]::WriteAllBytes($Path, [byte[]]($bom + $encoding.GetBytes($Text)))
}

if (Test-Path -LiteralPath $statePath) {
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  foreach ($entry in @($state.TallyIni)) {
    if (-not $entry.Path -or -not (Test-Path -LiteralPath $entry.Path -PathType Leaf)) { continue }
    $path = [string]$entry.Path
    $text = [IO.File]::ReadAllText($path)
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in [regex]::Split($text, "\r?\n")) {
      $remove = $false
      if ($line -match '^\s*TDL\s*=') {
        $value = ($line -replace '^\s*TDL\s*=\s*', '').Trim().Trim('"')
        foreach ($name in $managedNames) {
          if ([string]::Equals($value, (Join-Path $TdlDir $name), [StringComparison]::OrdinalIgnoreCase)) { $remove = $true; break }
        }
      }
      if (-not $remove) { $lines.Add($line) }
    }
    $remainingTdl = @($lines | Where-Object { $_ -match '^\s*TDL\s*=' -and $_ -notmatch '^\s*;' })
    if ($remainingTdl.Count -eq 0) {
      $userIndex = -1
      for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*User\s+TDL\s*=') { $userIndex = $i; break } }
      if ($userIndex -ge 0 -and $lines[$userIndex] -match '(?i)^\s*User\s+TDL\s*=\s*Yes\s*$') {
        if ($entry.HadUserTdlSetting) {
          $prefix = $lines[$userIndex] -replace '(?i)^(\s*User\s+TDL\s*=\s*).*$','$1'
          $lines[$userIndex] = $prefix + [string]$entry.OriginalUserTdl
        } else {
          $lines.RemoveAt($userIndex)
        }
      }
    }
    $updated = $lines -join $newline
    if ($updated -ne $text) {
      Copy-Item -LiteralPath $path -Destination "$path.pesowise-uninstall-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Write-PreservedText $path $updated
      Write-Output "Removed PesoWise startup entries from $path"
    }
  }
}

foreach ($task in @("PesoWiseSync", "PesoWiseConnector")) {
  & schtasks.exe /Delete /TN $task /F 2>$null | Out-Null
}
if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
$stateDir = Split-Path -Parent $statePath
if ((Test-Path -LiteralPath $stateDir) -and @(Get-ChildItem -LiteralPath $stateDir -Force -ErrorAction SilentlyContinue).Count -eq 0) { Remove-Item -LiteralPath $stateDir -Force }
Write-Output "Removed connector startup tasks and Tally startup entries. TDL files in $TdlDir were preserved to avoid deleting locally modified report files."
