# Install PesoWise's Tally connector and configure supported TallyPrime installs.
# Run elevated from the graphical installer. Pairing/startup is handled by the
# connector wizard after pairing succeeds, so no unpaired background task exists.
param(
  [string]$InstallDir = "$env:ProgramFiles\PesoWise\TallyConnector",
  [string]$TdlDir = "C:\pesowise"
)
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeSource = Join-Path $here "PesoWiseSync.exe"
$vbsSource = Join-Path $here "Run-PesoWiseConnector-Hidden.vbs"
if (-not (Test-Path -LiteralPath $exeSource -PathType Leaf)) { throw "Missing installer payload: $exeSource" }
if (-not (Test-Path -LiteralPath $vbsSource -PathType Leaf)) { throw "Missing installer payload: $vbsSource" }

New-Item -ItemType Directory -Force -Path $InstallDir, $TdlDir | Out-Null
Copy-Item -LiteralPath $exeSource -Destination (Join-Path $InstallDir "PesoWiseSync.exe") -Force
Copy-Item -LiteralPath $vbsSource -Destination (Join-Path $InstallDir "Run-PesoWiseConnector-Hidden.vbs") -Force

# Preserve any local edits to integration TDL files before an upgrade replaces them.
$tdlFiles = @("PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl", "PesoWise-Reports.tdl")
$tdlConfigFiles = @("PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl")
foreach ($name in $tdlFiles) {
  $source = Join-Path $here $name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing TDL installer payload: $source" }
  $destination = Join-Path $TdlDir $name
  if ((Test-Path -LiteralPath $destination -PathType Leaf) -and
      (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
    $backup = "$destination.pesowise-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $destination -Destination $backup
    Write-Output "Preserved previous TDL as $backup"
  }
  Copy-Item -LiteralPath $source -Destination $destination -Force
}
$sourceModules = Join-Path $here "tdl"
$targetModules = Join-Path $TdlDir "tdl"
if (-not (Test-Path -LiteralPath $sourceModules -PathType Container)) { throw "Missing TDL module folder: $sourceModules" }
New-Item -ItemType Directory -Force -Path $targetModules | Out-Null
Get-ChildItem -LiteralPath $sourceModules -File -Filter "*.tdl" | ForEach-Object {
  $destination = Join-Path $targetModules $_.Name
  if ((Test-Path -LiteralPath $destination -PathType Leaf) -and
      (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
    $backup = "$destination.pesowise-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $destination -Destination $backup
    Write-Output "Preserved previous TDL module as $backup"
  }
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

function Get-TallyIniCandidates {
  $roots = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($process in (Get-Process -Name "tally*" -ErrorAction SilentlyContinue)) {
    try { $path = $process.MainModule.FileName; if ($path) { [void]$roots.Add((Split-Path -Parent $path)) } } catch { }
  }
  $uninstallKeys = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($key in $uninstallKeys) {
    foreach ($app in (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)) {
      if ([string]$app.DisplayName -match "TallyPrime") {
        if ($app.InstallLocation -and (Test-Path -LiteralPath $app.InstallLocation)) { [void]$roots.Add([string]$app.InstallLocation) }
        if ($app.DisplayIcon -match '^\s*"?(.+?tally\.exe)"?(?:,\d+)?\s*$' -and (Test-Path -LiteralPath $matches[1])) {
          [void]$roots.Add((Split-Path -Parent $matches[1]))
        }
      }
    }
  }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base -and (Test-Path -LiteralPath $base)) {
      foreach ($dir in (Get-ChildItem -LiteralPath $base -Directory -Filter "TallyPrime*" -ErrorAction SilentlyContinue)) {
        [void]$roots.Add($dir.FullName)
      }
    }
  }
  foreach ($root in $roots) {
    $ini = Join-Path $root "tally.ini"
    if (Test-Path -LiteralPath $ini -PathType Leaf) { $ini }
  }
}

function Add-PesoWiseTdlToIni([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $encoding = [Text.Encoding]::Default
  $start = 0
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $encoding = [Text.UTF8Encoding]::new($true); $start = 3
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $encoding = [Text.UnicodeEncoding]::new($false, $true); $start = 2
  }
  $text = $encoding.GetString($bytes, $start, $bytes.Length - $start)
  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in [regex]::Split($text, "\r?\n")) { $lines.Add($line) }
  $disabled = $lines | Where-Object { $_ -match '(?i)^\s*User\s+TDL\s*=\s*No\s*$' } | Select-Object -First 1
  if ($disabled) {
    Write-Warning "Left $Path unchanged because User TDL=No. Enable user TDLs in TallyPrime or load the PesoWise TDL files manually."
    return
  }
  $changed = $false
  $userTdlSeen = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*User\s+TDL\s*=') {
      $userTdlSeen = $true
      if ($lines[$i] -notmatch '(?i)^\s*User\s+TDL\s*=\s*Yes\s*$') {
        $lines[$i] = $lines[$i] -replace '(?i)^(\s*User\s+TDL\s*=\s*).*$','$1Yes'
        $changed = $true
      }
      break
    }
  }
  if (-not $userTdlSeen) { $lines.Add("User TDL=Yes"); $changed = $true }
  foreach ($name in $tdlConfigFiles) {
    $fullPath = Join-Path $TdlDir $name
    $escaped = [regex]::Escape($fullPath)
    $exists = $false
    foreach ($line in $lines) {
      if ($line -match ("(?i)^\s*TDL\s*=\s*`"?" + $escaped + "`"?\s*$")) { $exists = $true; break }
    }
    if (-not $exists) { $lines.Add("TDL=$fullPath"); $changed = $true }
  }
  if ($changed) {
    $backup = "$Path.pesowise-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $Path -Destination $backup
    $result = $encoding.GetBytes(($lines -join $newline))
    if ($start -eq 3) { $result = [byte[]](@(0xEF,0xBB,0xBF) + $result) }
    elseif ($start -eq 2) { $result = [byte[]](@(0xFF,0xFE) + $result) }
    [IO.File]::WriteAllBytes($Path, $result)
    Write-Output "Configured TDL startup in $Path (backup: $backup)"
  }
}

$inis = @(Get-TallyIniCandidates | Sort-Object -Unique)
$iniState = @()
foreach ($ini in $inis) {
  $before = [IO.File]::ReadAllText($ini)
  $match = [regex]::Match($before, '(?im)^\s*User\s+TDL\s*=\s*([^\r\n;]+)')
  $originalValue = $null
  if ($match.Success) { $originalValue = $match.Groups[1].Value.Trim() }
  $iniState += [pscustomobject]@{
    Path = $ini
    HadUserTdlSetting = $match.Success
    OriginalUserTdl = $originalValue
  }
}
foreach ($ini in $inis) { Add-PesoWiseTdlToIni $ini }
$stateDir = Join-Path $env:ProgramData "PesoWise\TallyConnector"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$state = [pscustomobject]@{ TdlDir = $TdlDir; TallyIni = @($iniState) }
[IO.File]::WriteAllText((Join-Path $stateDir "installer-state.json"), (ConvertTo-Json -InputObject $state -Depth 4), [Text.UTF8Encoding]::new($true))
if ($inis.Count -eq 0) {
  Write-Warning "No supported TallyPrime tally.ini was detected. TDL files are installed in $TdlDir; load PesoWise-Bootstrap.tdl and PesoWise-Load.tdl manually from that folder after installing TallyPrime."
} else {
  Write-Output "Configured PesoWise TDL for $($inis.Count) TallyPrime installation(s). Restart TallyPrime to load the reports."
}
Write-Output "Connector installed to $InstallDir. Pairing will register the background connector only after successful authorization."
