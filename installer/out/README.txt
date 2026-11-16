PesoWise Tally connector — customer installer
Version: 0.6.0-company-verify

ONE-TIME SETUP
1. Copy PesoWise-Tally-Setup.exe to the Windows PC that runs TallyPrime.
2. Double-click it and approve the Windows administrator prompt. Keep the
   default install location and finish the setup wizard.
3. The installer copies the connector and reports, then opens the PesoWise
   pairing page in your browser. Sign in to the intended PesoWise organization
   and complete pairing once on this PC.
4. Restart TallyPrime once so it loads the installed PesoWise reports. Open the
   company that is configured for this PesoWise organization; the connector
   checks that the active company matches before delivery.
5. Open PesoWise Reports and sync a newly reviewed report. Do not retry old
   queued or manual-review jobs as part of setup.

The installer adds only these startup entries to detected TallyPrime tally.ini
files when User TDL is enabled:
  C:\pesowise\PesoWise-Bootstrap.tdl
  C:\pesowise\PesoWise-Load.tdl
Existing Tally.ini settings are backed up and preserved. A deliberate
User TDL=No setting is left unchanged. Restart TallyPrime once after
installation so the reports are loaded. If no installation is detected or
User TDL is disabled, load those two files through TallyPrime F12 settings.

This build is for controlled customer acceptance, not a signed public release.
Windows may identify the installer publisher as unknown because this EXE is
not Authenticode-signed.

Pair once using the browser setup page opened by the installer. The connector
logon task is registered only after successful pairing. Use Reports → Sync to
Tally to deliver a newly reviewed report. It does not sweep old queued jobs.

Before uninstalling, revoke the connector from PesoWise Admin → Tally if
server-side token invalidation is required. The uninstaller removes only the
PesoWise tally.ini entries, local connector task and token; it preserves TDL
files in C:\pesowise to avoid deleting user-modified files.

Troubleshooting: see docs/12-customer-guide.md and docs/14-troubleshooting-guide.md.
