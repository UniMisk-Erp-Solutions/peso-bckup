# Phase 3.5 — Deploy & validate Tally preparation pipeline

**Final validation date:** 2026-10-05 (post-deploy on `192.168.23.46`, PesoWise stack `kar0ro1k6jiyfxzzw7acnsza` only)  
**Final status:** **PARTIAL PASS** — remote deploy + automated live E2E **PASS**; manual gates (browser-independence, auth negatives, idempotency) **NOT RUN**.

---

## Executive summary

| Area | Status |
|------|--------|
| Repo implementation Phase 2/3/3.6 | **Complete** |
| Migrations applied to remote | **Yes** (Phase 2, 3, 3.6 + `20261005190000` expense status cast) |
| Edge workers deployed | **Yes** — `run-tally-sync-job`, `start-tally-sync`, `_shared/tallySync`; edge runtime restarted |
| Four-report live E2E (worker invoke) | **PASS** (see §4) |
| Large org (>1000 rows) | **PASS** — 2514 prepared items |
| Browser-independence live test | **NOT RUN** |
| Role / cross-org auth negatives | **NOT RUN** |
| Idempotency / failure-retry live | **NOT RUN** |
| Automated regression (142 tests) | **PASS** (local, pre-deploy) |
| Phase 3.6 silent UI + single request | **PASS** (code + tests; live UI not exercised here) |

---

## 1. Environment

| Item | Finding |
|------|---------|
| Target URL | `https://pesowise-backup-supabase.unimisk.com` |
| Host | `192.168.23.46` (Coolify); **only** PesoWise Supabase service touched |
| Classification | Live PesoWise **backup** Supabase — not an empty staging DB |
| `run-tally-sync-job` (service role, no job) | `{"claimed":false}` |
| `run-tally-sync-job` (with job_id) | Claims and prepares through **`prepared`** |
| `start-tally-sync` (service role only) | **Unauthorized** (expected; requires user JWT) |

Deploy guide: `scripts/tally-integration/DEPLOY-PESOWISE-BACKUP-SUPABASE.md`  
Remote helper: `scripts/tally-integration/remote-deploy-46.mjs`

---

## 2. Migrations (remote)

Applied in order:

1. `20261005160000_tally_sync_jobs_phase2.sql`
2. `20261005170000_tally_sync_preparation_phase3.sql`
3. `20261005180000_tally_sync_background_phase36.sql`
4. `20261005190000_report_expense_rows_status_text_cast.sql` — fixes `expense_status = text` on `report_expense_rows_v1`

Verified: `tally_sync_jobs`, `tally_sync_job_items`; tally RPCs present.

---

## 3. Worker deployment

| Function | Remote state |
|----------|----------------|
| `run-tally-sync-job` | **OK** |
| `start-tally-sync` | **Deployed** (JWT-gated enqueue + background dispatch) |

---

## 4. Live E2E (2026-10-05, `scripts/tally-integration/_remote-e2e-run.mjs`)

Direct DB insert (`queued`) + `POST run-tally-sync-job` with service role (simulates worker path after Phase 3.6 dispatch).

| Label | Org | Report | Result | prepared_item_count | items table |
|-------|-----|--------|--------|---------------------|-------------|
| claim_verification_no_filter_small | small | claim_verification | **prepared** | 0 | 0 |
| claim_approval_no_filter_small | small | claim_approval | **prepared** | 1345 | 1345 |
| detailed_default_year_small | small | detailed_expense | **prepared** | 1266 | 1266 |
| daily_all_time_small | small | daily_project_report | **prepared** | 168 | 168 |
| claim_verification_no_filter_large | large | claim_verification | **prepared** | 2514 | 2514 |

**Notes:**

- Small-org claim verification with **0** rows is consistent with **no rows matching that report’s filters** on that org; large-org claim verification confirms the report path at scale.
- Job IDs: `1da3c0d9-…`, `453feeb6-…`, `2499e6de-…`, `2b0adfc3-…`, `255fd764-…` (backup DB; safe audit trail).

---

## 5. Still outstanding (before calling Phase 3.5 fully **PASS**)

1. Admin UI: click sync once → **`start-tally-sync`** → job reaches **`prepared`** with browser closed (no polling).
2. Non-admin / cashier / team role → deny; cross-org → deny.
3. Same dedupe_key / retry → no duplicate `tally_sync_job_items`.
4. Optional: filtered variants per report (Phase 1 audit matrix).

---

## 6. Automated validation **PASS** (local)

**142 tests** — Phase 2/3/3.6 contracts, resolvers, paging, UI silent sync.

---

## 7. Typecheck / lint / build

| | |
|--|--|
| Tally-scoped eslint | **PASS** |
| Full tsc | **FAIL** — pre-existing |
| Full lint | **FAIL** — pre-existing |
| Build | **PASS** |

---

## 8. Phase 3.6 cross-reference

**[PHASE-03.6-BACKEND-PIPELINE.md](./PHASE-03.6-BACKEND-PIPELINE.md)**

---

## 9. Phase 4 readiness (this gate)

| Criterion | Met? |
|-----------|------|
| Prepared datasets without Tally I/O | **Yes** (live backup) |
| All four report types reach `prepared` | **Yes** (CV small = empty dataset) |
| >1000 real rows | **Yes** (2514) |
| Full operator checklist §5 | **No** |

**Recommendation:** Safe to **start Phase 4 implementation** (Tally delivery from `prepared` / items) on this backup stack **after you confirm** manual §5 checks—or accept risk and run them in parallel. **Not** a sign-off for production Tally push until §5 is complete.
