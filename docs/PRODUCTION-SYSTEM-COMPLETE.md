# Production Tally system — integrated delivery

Phases 4–9 capabilities are wired into one workable flow (tray icon deferred; hidden logon task used instead).

## Components

| Layer | What |
|-------|------|
| Web | Reports sync + **`/admin/tally`** pairing & health |
| Cloud | Existing Edge + Postgres job/batch queue |
| PC | **`installer/out`** → EXE, TDL, install script, hidden runner |
| Tally | `:9000` + Bootstrap + Load TDL |

## Quick start (MicroLink test org)

1. **Build bundle:** `node scripts/tally-integration/build-customer-bundle.mjs`
2. **Install on Tally PC:** run `installer/out/Install-PesoWise-Tally.ps1` as Admin
3. **Web:** `/admin/tally` → save company → generate code → run pair command on PC
4. **Tally:** Load TDL from `C:\pesowise`, enable HTTP 9000
5. **Reports:** Sync to Tally — close browser if connector shows online

Full checklist: **`docs/E2E-PRODUCTION-RUNBOOK.md`**.
