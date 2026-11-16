# Phase 3.6 — Silent backend Tally preparation pipeline

## 1. Objective

After Admin clicks **Sync to Tally**, a **single** backend request accepts work; the browser does not invoke the worker, poll job status, or show internal pipeline state. Processing continues if the user navigates away or closes the tab.

## 2. Architecture

```
Admin UI — startTallySync() once
        ↓
Edge: start-tally-sync
        ↓ (user JWT → create_tally_sync_job_v1)
tally_sync_jobs (queued)
        ↓ EdgeRuntime.waitUntil
Edge: run-tally-sync-job (service_role, job_id)
        ↓
processing → prepared + tally_sync_job_items
```

Generate Report path is unchanged (still uses `run-report-export-job` + optional browser nudge).

## 3. Environment

Same as Phase 3.5: local dev targets `https://pesowise-backup-supabase.unimisk.com` (Coolify `kar0ro1k6jiyfxzzw7acnsza` on 192.168.23.46). **No isolated staging Supabase** configured on the validation workstation.

## 4. Migrations

New: `20261005180000_tally_sync_background_phase36.sql`

- `dispatch_requested_at` (optional ops column)
- `mark_tally_sync_dispatch_requested_v1` (service_role)
- `recover_stale_tally_sync_jobs_v1` (service_role)

Apply **after** Phase 2 + Phase 3 migrations.

## 5. Worker deployment fix

Remote `run-tally-sync-job` previously returned **500 InvalidWorkerCreation / entrypoint** — function name registered without deployed source tree.

**Fix:** Deploy complete folders to edge runtime volume (see `scripts/tally-integration/DEPLOY-PESOWISE-BACKUP-SUPABASE.md`), including `_shared/tallySync/`, then restart edge runtime. Smoke: `POST run-tally-sync-job` with service role → `{ "claimed": false }`, not 500.

## 6. Server-side dispatch mechanism

**`start-tally-sync` Edge Function:**

1. Validates `Authorization` bearer (admin enforced inside `create_tally_sync_job_v1`).
2. Calls `create_tally_sync_job_v1` with **user-scoped** Supabase client (`auth.uid()` preserved).
3. Dispatches `run-tally-sync-job` with **service role** and `{ job_id }`.
4. Uses **`EdgeRuntime.waitUntil`** so HTTP response returns `{ accepted: true }` while worker runs asynchronously.

**Backstop:** Periodic `POST run-tally-sync-job` with `{}` (global queue drain) + `recover_stale_tally_sync_jobs_v1()` for stale `processing`.

## 7. Browser independence

Frontend calls **`supabase.functions.invoke("start-tally-sync", …)`** only. No `run-tally-sync-job`, no `tally_sync_jobs` SELECT, no polling.

Worker continuation does not depend on browser session after `accepted: true`.

**E2E browser-close test:** **NOT RUN** (remote pipeline not deployed on approved target during this validation).

## 8. Silent UI behavior

Admin sees:

- **Report actions:** `[ Generate report ]` `[ Sync to Tally ]`
- While request in flight: button **Syncing…** + spinner
- On success: optional line **Sync started.** (`data-testid="tally-sync-ack"`)
- On failure: **Unable to start Tally sync. Please try again.**

Admin does **not** see: queued/processing/prepared, job IDs, counts, history panel, technical errors.

## 9–12. Four report E2E

**NOT RUN** on remote (migrations/worker not applied — see Phase 3.5 final status).

Unit/static tests cover frozen parameters and resolvers per report type.

## 13–16. No-filter / filtered / pagination / >1000

**Remote:** NOT RUN.

**Automated:** PASS — paging invariants, R2/R3, default-year, daily all_time, simulated **1200** rows.

## 17–20. Prepared items / idempotency / failure / auth

**Remote:** NOT RUN.

**Contract:** migration + worker tests; admin-only RPC; org RLS on jobs/items.

## 21. Backend observability

`tally_sync_jobs` retains status, timestamps, counts, errors, heartbeat, `dispatch_requested_at`. Not exposed in Reports UI.

## 22. Regression tests

**142 tests PASS** (2026-10-05) including Phase 3.6 suite and report export regressions.

## 23. Test results

See §22. Phase 3.6 file: `src/lib/__tests__/tallySyncPhase36.test.ts`.

## 24. Typecheck / lint / build

| Check | Result |
|-------|--------|
| Tally-scoped eslint | **PASS** |
| Full `tsc` | **FAIL** — pre-existing (generated types / ExpenseService) |
| Full lint | **FAIL** — pre-existing backlog |
| `npm run build` | **PASS** |

## 25. Files changed (Phase 3.6)

- `supabase/functions/start-tally-sync/`
- `supabase/migrations/20261005180000_tally_sync_background_phase36.sql`
- `src/lib/tallySyncJobs.ts` — `startTallySync`
- `src/components/ServerReportExportPanel.tsx` — silent UI
- Tests + deploy/validate scripts under `scripts/tally-integration/`

## 26. Production changes

**None** applied during Phase 3.6 validation on `.46`.

## 27. Remaining limitations

- Remote E2E blocked until approved deploy
- `start-tally-sync` must be deployed alongside `run-tally-sync-job`
- Cron/backstop for queue drain is operational (documented), not auto-installed in repo

## 28. Rollback

- Remove/disable `start-tally-sync` route
- UI falls back to no-op if function missing (generic failure message)
- DB: optional drop Phase 3.6 column/RPC only if no jobs depend on them

## 29. Phase 4 readiness

**NOT READY** until Phase 3.5 remote validation completes (migrations + worker + four-report E2E + browser-independence proof on approved environment).

## 30. No Phase 4 work

No TallyPrime, XML, connector, TDL, or voucher I/O in Phase 3.6.
