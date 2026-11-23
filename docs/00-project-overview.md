# PesoWise → TallyPrime — Project Overview

## Purpose

Enable PesoWise customers to sync report data from the **PesoWise web app** into **TallyPrime** and view it via custom **PesoWise Reports** (Daily Project, Claim Verification, Claim Approval, Detailed Expense).

## Success definition (customer journey)

1. Install TallyPrime and **PesoWise Setup.exe**
2. Sign in to PesoWise once; device pairs automatically
3. Click **Sync to Tally** on the website
4. Sync completes with browser closed
5. Open Tally → **Gateway → PesoWise Reports** → data visible

## Current maturity (audit date: 2026-10-08)

| Area | Status |
|------|--------|
| Server sync pipeline (jobs, batches, mapping) | **Working** (MicroLink / backup stack) |
| Connector claim/ack API | **Working** |
| Dev delivery path (Vite + local bridge :9876) | **Working** |
| Production EXE (`PesoWise-Tally-Connector.exe`) | **Buildable** (`pkg`); not shipped via Setup.exe |
| Setup.exe / TDL auto-install | **Designed**, not implemented |
| Web-based pairing UX | **Partial** (CLI `pair`; admin RPC exists) |
| Background sync without browser | **Partial** (server queues; connector `run` loop exists; dev relies on bridge) |
| System tray / health dashboard | **Not implemented** |
| Empty Tally reports | **Known issue** (Phase 2) |

## Documentation map

| Doc | Content |
|-----|---------|
| `01-current-architecture.md` | As-built system |
| `02-current-issues.md` | Known defects (summary) |
| `03-production-architecture.md` | Target production shape |
| `Phase-1-Report.md` | Full Phase 1 audit |
| `docs/tally-integration/*` | Historical phase 1–5.3 integration docs |

## Principles (locked)

- Keep **Supabase Edge Functions** and **tally_sync_*** tables
- Keep **XML mapping** and **TDL read model**
- Incremental migration; no rewrite
- Website = primary UI; connector = background infrastructure
