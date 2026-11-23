# Phase 1 Report — System Audit

**Date:** 2026-10-08  
**Scope:** Full codebase analysis for production migration  
**Code changes:** None (documentation only)

---

## 1. Objective

Establish an accurate **as-built** picture of the PesoWise → TallyPrime integration, document flows and dependencies, and identify **production blockers**, **technical debt**, **security**, and **scalability** concerns before Phases 2–10.

---

## 2. Existing Behavior

- Admins use the **React Reports UI** to **Generate report** (CSV export job) and **Sync to Tally** (separate `tally_sync_jobs` pipeline).
- **Sync** is a single Edge call (`start-tally-sync`); the browser does not run the preparation worker directly.
- Preparation and batch enqueue run on **Supabase Edge** (`run-tally-sync-job`, `run-tally-sync-delivery`).
- **Delivery** requires a **paired connector** on the customer PC calling `tally-connector` (claim/ack) and posting XML to **Tally HTTP :9000**.
- **Development** auto-starts `main.js serve` (local bridge **:9876** + service loop) via **Vite plugin**; the UI polls jobs and POSTs **deliver-job** for bound delivery.
- **Tally reports** read metadata ledgers via **TDL collections** (not live JSON evaluation at report time).

---

## 3. Root Cause Analysis (why this phase)

Production customer requirements (Setup.exe, no npm, background sync, health UI) cannot be implemented safely without a **single shared understanding** of what already exists. Phase 1 prevents redundant rewrites and documents gaps (e.g. dual delivery paths, missing installer).

*Empty-report investigation is **Phase 2** — not concluded in Phase 1.*

---

## 4. Architecture Analysis

### Components

| Layer | Components |
|-------|------------|
| Frontend | `ServerReportExportPanel`, `tallySyncJobs`, `tallySyncJobPoll`, `localTallyBridge` |
| Edge | `start-tally-sync`, `run-tally-sync-job`, `run-tally-sync-delivery`, `tally-connector` |
| Shared mapping | `tallyMapping/*`, `tallySync/enqueueDeliveryBatches.ts` |
| Connector | `connector/tally` (CLI, service loop, deliver batch, local bridge) |
| TDL | `tally-extension/*` |
| Ops | `scripts/tally-integration/*` |

### Diagrams

See `docs/01-current-architecture.md` (context + sequence Mermaid).

### Target vs current

See `docs/03-production-architecture.md`.

---

## 5. Files Investigated

| Path | Purpose |
|------|---------|
| `src/components/ServerReportExportPanel.tsx` | Sync UI, polling, bridge health, deliver nudge |
| `src/lib/tallySyncJobs.ts` | Start sync Edge invoke |
| `src/lib/tallySyncJobPoll.ts` | Batch summary, progress strings |
| `src/lib/tallySyncParameters.ts` | Job parameters |
| `src/lib/localTallyBridge.ts` | Dev bridge client |
| `src/lib/tallyMapping/*` | Map prepared rows → Tally XML |
| `vite.config.ts` | Dev connector auto-start |
| `scripts/run-dev.mjs` | Vite launcher |
| `supabase/functions/start-tally-sync/index.ts` | Job create + worker dispatch |
| `supabase/functions/run-tally-sync-job/index.ts` | Dataset preparation |
| `supabase/functions/run-tally-sync-delivery/index.ts` | Batch enqueue entry |
| `supabase/functions/tally-connector/index.ts` | Device API |
| `supabase/functions/_shared/tallySync/enqueueDeliveryBatches.ts` | Chunked enqueue |
| `supabase/functions/_shared/tallyMapping/*` | Edge copy of mapper |
| `supabase/migrations/20261005160000_tally_sync_jobs_phase2.sql` | Jobs table |
| `supabase/migrations/20261007120000_tally_connector_phase5.sql` | Devices, batches, RPCs |
| `connector/tally/src/main.ts` | Commands: pair, run, serve, doctor |
| `connector/tally/src/serviceLoop.ts` | Background claim loop |
| `connector/tally/src/deliverJob.ts` | Job-scoped delivery |
| `connector/tally/src/deliverBatch.ts` | Verified Tally POST |
| `connector/tally/src/localBridge.ts` | :9876 HTTP |
| `connector/tally/src/pesoApi.ts` | Edge client |
| `connector/tally/src/config.ts` | `%USERPROFILE%\PesoWise\TallyConnector\config.json` |
| `connector/tally/scripts/build-win-exe.mjs` | pkg EXE |
| `connector/tally/scripts/install-startup.ps1` | Scheduled task reference |
| `tally-extension/PesoWise-*.tdl` | Bootstrap, Load, Reports, SafeMenu |
| `docs/tally-integration/FINAL-PRODUCTION-ARCHITECTURE.md` | Locked architecture doc |
| `docs/tally-integration/UNIVERSAL-INSTALLER-DESIGN.md` | Installer design |

---

## 6. Files Modified

**None** (Phase 1 constraint).

Documentation added under `docs/` (see § Documentation Deliverables).

---

## 7. Database Changes

**None** in Phase 1.

Existing schema (reference):

- `tally_sync_jobs`, `tally_sync_job_items`, `tally_sync_delivery_batches`, `tally_delivery_state`
- `tally_connector_devices`, `tally_connector_pairing_codes`, `tally_org_connector_config`
- RPCs: `create_tally_sync_job_v1`, `connector_claim_delivery_batch_v1`, `connector_ack_delivery_batch_v1`, `exchange_tally_connector_pairing_v1`, `resolve_tally_connector_device_v1`, etc.

---

## 8. API Changes

**None** in Phase 1.

Documented contracts:

| Endpoint | Auth | Actions |
|----------|------|---------|
| `POST /functions/v1/start-tally-sync` | User JWT | Create job, dispatch worker |
| `POST /functions/v1/run-tally-sync-job` | Service role | Prepare items |
| `POST /functions/v1/run-tally-sync-delivery` | Service role | Enqueue XML batches |
| `POST /functions/v1/tally-connector` | `X-Connector-Token` | heartbeat, claim, ack, job_batches |
| `GET http://127.0.0.1:9876/v1/health` | None (local) | Dev bridge status |

---

## 9. Frontend Changes

**None** in Phase 1.

Noted behavior:

- Sync survival on **refresh**: yes (polls `fetchLatestTallySyncJob` + batch summary).
- Sync survival on **browser close**: **only if connector keeps delivering** — today dev leans on bridge + optional loop; not guaranteed for production `run` vs `serve` split.
- Pairing UX: messages reference CLI pairing; **no** in-app pairing wizard found in `src/pages`.

---

## 10. Connector Changes

**None** in Phase 1.

Findings:

| Command | Behavior |
|---------|----------|
| `pair` | Writes config with device token |
| `run` | Single-instance lock + `runServiceLoop` |
| `serve` | Bridge + loop (dev) |
| `deliver-job` | Uses `deliverEntireJob` → `deliverBoundBatch` |
| `doctor` | Config, auth, Tally TCP |

**Gap:** `runServiceLoop` uses simple `tally.postXml`; `deliverBoundBatch` uses `postTallyBatchVerified` (split, duplicate Alter, active-company retry). Production agent must unify on the stronger path (Phase 4).

---

## 11. Tally Integration Changes

**None** in Phase 1.

Flow documented:

1. XML Import → All Masters → metadata ledgers + UDFs  
2. TDL collection `PW DPR Latest` → filter non-empty `PESOWISE_DPR_TRACK_DATE`  
3. Wrong TDL file (`PesoWise-Reports-SafeMenu.tdl`) → **placeholder reports with no data**

---

## 12. Security Considerations

| Risk | Mitigation / note |
|------|-------------------|
| Stolen device token | Revoke device; token hash in DB |
| Pairing code brute force | Short expiry; hashed codes |
| Local bridge exposed | Bind 127.0.0.1 only; do not expose in production installer |
| Anon key in pairing CLI | Required for RPC; use project-specific key |
| XML injection | Escaping in `xml/escape.ts` |
| Cross-org job claim | Edge checks `organization_id` on job_batches |

---

## 13. Test Cases

### Phase 1 (audit) — positive

| ID | Test | Result |
|----|------|--------|
| T1 | Trace sync from UI to batch table | Pass (documented) |
| T2 | Verify connector API actions in Edge | Pass (code review) |
| T3 | Verify pairing RPC migration exists | Pass |
| T4 | Verify EXE build script exists | Pass |

### Phase 1 — negative / N/A

| ID | Test | Result |
|----|------|--------|
| T5 | Full E2E on clean Windows VM | **Deferred** (Phase 9–10) |
| T6 | Run full vitest suite | **Not executed** in Phase 1 |

Future phases must run mandatory failure matrix (browser close, restart, etc.) — see `docs/09-testing-validation.md`.

---

## 14. Validation Results

| Evidence type | Result |
|---------------|--------|
| Code path trace | Complete — see `01-current-architecture.md` |
| Prior live incidents (MicroLink) | Documented in `02-current-issues.md` and conversation history |
| Automated test run | Not required for audit-only phase |
| Screenshots | N/A |

---

## 15. Rollback Plan

**N/A** — no production code or schema changes in Phase 1.

Documentation rollback: revert git commits touching `docs/` only.

---

## 16. Risks Remaining

| Risk | Severity | Owner phase |
|------|----------|-------------|
| Dual mapper copies drift from `src/` to Edge | High | 3–4 (sync + CI) |
| Empty reports multi-cause | High | 2–3 |
| Dev bridge mistaken for production | High | 4–7 |
| No Setup.exe | High | 9 |
| Manual TDL load | High | 9 |
| `serviceLoop` weaker than `deliverBatch` | Medium | 4 |
| Doc drift (Alter policy vs code) | Low | 10 |
| Edge deploy manual SSH | Medium | 11 |

---

## 17. Next Phase Preparation

### Phase 2 — Current issue (empty reports)

**Objective:** Trace full chain with **proof** (DB batch XML sample, Tally export, TDL filter, ledger counts).

**Dependencies:**

- Tally running with correct company on HTTP  
- Access to backup DB / job IDs  
- Scripts: `_tally-diagnose-dpr-empty.mjs`, `_tally-active-ledgers.mjs`, `backfill-dpr-flat-udfs.mjs`

**Assumptions:**

- Sync jobs can show `completed` + `delivered` while report empty  
- Hypotheses ranked: (1) SafeMenu TDL, (2) missing flat UDFs, (3) HTTP company binding, (4) all-skipped batches, (5) wrong Tally company file

**Do not implement fixes in Phase 2** until root cause confirmed.

---

## Production blockers (consolidated)

1. **Customer runtime:** depends on `npm run dev` + local bridge in practice  
2. **Pairing:** CLI-only; no Setup wizard  
3. **TDL:** manual F12 / copy to `C:\pesowise`  
4. **Agent delivery path split** (`serviceLoop` vs `deliverBoundBatch`)  
5. **No tray, health dashboard, or notifications**  
6. **No Setup.exe**  
7. **Empty report** — unresolved (Phase 2)

## Technical debt (consolidated)

- Vite connector plugin + Microlink auto-pair script  
- SafeMenu vs Load TDL confusion  
- Coolify SSH deploy scripts  
- CSV export row count ≠ sync job rows  
- Locked architecture doc vs force-refresh Create/Alter behavior  

## Scalability notes

- Chunked delivery (`ITEMS_PER_CHUNK`, continuation fetch) supports large jobs  
- Batch claim leases + reclaim migration (`20261007210000`)  
- Single connector per org per PC (`installation_id` unique per org) — multi-company future needs config v2 (`pairings[]` comment in config.ts)

## Documentation deliverables (Phase 1)

| File | Status |
|------|--------|
| `docs/00-project-overview.md` | Created |
| `docs/01-current-architecture.md` | Created |
| `docs/02-current-issues.md` | Created |
| `docs/03-production-architecture.md` | Created |
| `docs/04`–`docs/15` | Stubs / placeholders |
| `docs/09-testing-validation.md` | Phase 1 checklist |
| `docs/Phase-1-Report.md` | This document |

---

**Phase 1 status: COMPLETE** (audit + documentation; no code changes).

**Next step:** Begin **Phase 2 — Current Issue** (investigation only).
