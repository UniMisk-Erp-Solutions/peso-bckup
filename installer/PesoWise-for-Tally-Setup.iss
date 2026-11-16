; Customer-facing single-file installer, compiled by build-setup-installer.mjs.

#define MyAppName "PesoWise for Tally"
#define MyAppVersion "0.6.0-company-verify"
#define MyAppPublisher "PesoWise"
#define MyAppExeName "PesoWiseSync.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\PesoWise\TallyConnector
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
VersionInfoVersion=0.6.0.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoProductName={#MyAppName}
OutputBaseFilename=PesoWise-Tally-Setup
OutputDir=release
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin

[Files]
Source: "out\*"; Excludes: "*.before-*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName} Setup"; Filename: "{app}\{#MyAppExeName}"; Parameters: "setup"
Name: "{autodesktop}\{#MyAppName} Setup"; Filename: "{app}\{#MyAppExeName}"; Parameters: "setup"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Install-PesoWise-Tally.ps1"" -InstallDir ""{app}"" -TdlDir ""C:\pesowise"""; StatusMsg: "Installing PesoWise Tally reports and connector..."; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Parameters: "setup"; Description: "Pair this PC with PesoWise"; Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Uninstall-PesoWise-User.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemovePesoWiseUserState"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Uninstall-PesoWise-Tally.ps1"" -TdlDir ""C:\pesowise"""; Flags: runhidden waituntilterminated; RunOnceId: "RemovePesoWiseTallySettings"
