#!/usr/bin/env node
/**
 * Assembles installer/out for customer PCs: EXE, TDL, install script, hidden runner.
 */
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "installer", "out");
const connectorRoot = join(root, "connector", "tally");
const exe = join(connectorRoot, "dist", "PesoWiseSync.exe");
const tdlSrc = join(root, "tally-extension");

if (!existsSync(exe)) {
  console.log("Building connector EXE…");
  const r = spawnSync("npm.cmd", ["run", "package:win"], { cwd: connectorRoot, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

mkdirSync(out, { recursive: true });
cpSync(exe, join(out, "PesoWiseSync.exe"));
for (const f of ["PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl", "PesoWise-Reports.tdl"]) {
  cpSync(join(tdlSrc, f), join(out, f));
}
cpSync(join(tdlSrc, "tdl"), join(out, "tdl"), { recursive: true });

writeFileSync(
  join(out, "Run-PesoWiseConnector-Hidden.vbs"),
  `Set sh = CreateObject("Wscript.Shell")\r\nsh.Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\\PesoWiseSync.exe"" run", 0, False\r\n`,
  "utf-8",
);

const installPs1 = `# PesoWise Tally — customer install (run as Administrator)
param(
  [string]$InstallDir = "$env:ProgramFiles\\PesoWise\\TallyConnector",
  [string]$TdlDir = "C:\\pesowise",
  [switch]$SkipStartup
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $here "PesoWiseSync.exe") (Join-Path $InstallDir "PesoWiseSync.exe") -Force
Copy-Item (Join-Path $here "Run-PesoWiseConnector-Hidden.vbs") (Join-Path $InstallDir "Run-PesoWiseConnector-Hidden.vbs") -Force
New-Item -ItemType Directory -Force -Path $TdlDir | Out-Null
Copy-Item (Join-Path $here "*.tdl") $TdlDir -Force
Copy-Item (Join-Path $here "tdl") (Join-Path $TdlDir "tdl") -Recurse -Force
Write-Host "Installed to $InstallDir and TDL to $TdlDir"
if (-not $SkipStartup) {
  $vbs = Join-Path $InstallDir "Run-PesoWiseConnector-Hidden.vbs"
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName "PesoWiseConnector" -Action $action -Trigger $trigger -Settings $settings -Force
  Write-Host "Registered logon task PesoWiseConnector (hidden)"
}
Write-Host "Next: pair once — see PesoWise web Admin > Tally integration"
`;
writeFileSync(join(out, "Install-PesoWise-Tally.ps1"), installPs1, "utf-8");

let version = "unknown";
try {
  const m = readFileSync(join(connectorRoot, "src", "doctor.ts"), "utf-8").match(/AGENT_VERSION\s*=\s*"([^"]+)"/);
  if (m) version = m[1];
} catch {
  /* ok */
}
writeFileSync(
  join(out, "README.txt"),
  `PesoWise Tally customer bundle\r\nversion=${version}\r\nbuilt=${new Date().toISOString()}\r\n\r\n1. Run Install-PesoWise-Tally.ps1 as Administrator\r\n2. Load TDL in Tally from C:\\pesowise\r\n3. Pair from PesoWise Admin > Tally integration\r\n4. Sync from Reports — connector delivers in background\r\n`,
  "utf-8",
);

console.log(`Customer bundle ready: ${out}`);
