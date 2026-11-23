# PesoWise Tally customer installer

## Build bundle (developers)

From repo root:

```powershell
node scripts/tally-integration/build-customer-bundle.mjs
```

Output: **`installer/out/`**

| File | Purpose |
|------|---------|
| `PesoWiseSync.exe` | Background agent |
| `Install-PesoWise-Tally.ps1` | Copies EXE + TDL, registers logon task (hidden via VBS) |
| `Run-PesoWiseConnector-Hidden.vbs` | No console window |
| `*.tdl` + `tdl/` | Copy to `C:\pesowise` |

## Customer steps

See **`docs/E2E-PRODUCTION-RUNBOOK.md`** and PesoWise **Admin → Tally integration**.

## Inno Setup (optional)

You can wrap `installer/out` in Inno Setup to produce `PesoWise-for-Tally-Setup.exe`; the PowerShell installer is sufficient for internal rollout.
