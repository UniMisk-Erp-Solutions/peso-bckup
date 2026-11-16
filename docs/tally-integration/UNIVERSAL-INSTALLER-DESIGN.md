# Universal installer design — PesoWise-for-Tally-Setup.exe

**Target:** one EXE for all customers. **Not built in CI this session.**

## Contents (phased)

| Phase | Component |
|-------|-----------|
| Now | PesoWise Tally Agent binary (`pkg` output from `connector/tally/scripts/build-win-exe.mjs`) |
| Later | Bundled `PesoWise.tcp` (placeholder directory only — no TCP authored here) |
| Later | Scheduled Task / service for logon startup |

## Install steps (customer)

1. Run **PesoWise-for-Tally-Setup.exe**
2. Install Agent to `%ProgramFiles%\PesoWise\TallyAgent\` (proposed)
3. Create config dir `%USERPROFILE%\PesoWise\TallyConnector\`
4. Wizard: **Connect PesoWise** → pairing code + pick/confirm Tally company
5. Optional: register startup task (`connector/tally/scripts/install-startup.ps1` reference)

## Uninstall / upgrade

- Uninstall: stop task, remove binary, offer to delete config (revoke device from Admin recommended first)
- Upgrade: replace binary; preserve `config.json` and logs

## Build pipeline (dev)

```powershell
cd connector/tally
npm install
npm run build
npm run package:win
# dist/PesoWise-Tally-Connector.exe
```

Installer authoring (Inno Setup / WiX) — stub: `installer/README.md`.

## TCP readiness

Installer layout reserves `{app}\TallyExtension\` for future `PesoWise.tcp` copy; Agent does not load TCP until Phase 6.
