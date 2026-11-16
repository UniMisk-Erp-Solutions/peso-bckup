# Phase 3 — Server-side dataset resolver, worker & idempotency foundation

## 1. Objective

Process admin-queued `tally_sync_jobs` on the server: claim atomically, reproduce the **full** report dataset from frozen parameters (never browser rows), apply Tally-only filter parity (R2/R3, soft-delete), normalize payloads, persist chunked items, and end in status **`prepared`**. No TallyPrime, XML, connector, TDL, or production deploy in this phase.

## 2. Architecture

```
Admin → Sync to Tally → tally_sync_jobs (queued)
                              ↓
              Edge `run-tally-sync-job` (service_role)
                              ↓
         claim_tally_sync_job_v1 → processing
                              ↓
    Report RPC paging (expense / detailed V4 / daily V1)
                              ↓
    Tally boundary filters (custom fields, deleted_at, approval_tier)
                              ↓
    store_tally_sync_job_items_chunk_v1 → tally_sync_job_items
                              ↓
    complete_tally_sync_preparation_v1 → prepared
```

## 3. Worker architecture

- **Function:** `supabase/functions/run-tally-sync-job/index.ts`
- **Auth:** Service role bearer or validated user JWT (same pattern as `run-report-export-job`).
- **Claim:** `claim_tally_sync_job_v1` uses `FOR UPDATE SKIP LOCKED`; clears prior `tally_sync_job_items` for safe retry.
- **Progress:** `tally_sync_job_heartbeat_v1` updates counts/checkpoint column (checkpoint reserved for future resumable batches).
- **No ~50s hard fail:** Unlike the export worker soft deadline, preparation does not abort on a fixed wall-clock cap in Phase 3 (large org datasets rely on paging + chunk inserts).

## 4. Job lifecycle

| Status | Meaning |
|--------|---------|
| `queued` | Waiting for worker |
| `processing` | Worker owns job |
| **`prepared`** | **Phase 3 success — dataset ready, not delivered to Tally** |
| `completed` | Reserved for future end-to-end Tally sync success |
| `failed` | Preparation failed (or exhausted retries) |

Active dedupe index: `queued` + `processing` only (`prepared` does not block new jobs).

## 5. Files changed

| Area | Path |
|------|------|
| Migration | `supabase/migrations/20261005170000_tally_sync_preparation_phase3.sql` |
| Worker | `supabase/functions/run-tally-sync-job/index.ts`, `config.toml` |
| Shared (edge) | `supabase/functions/_shared/tallySync/contentHash.ts`, `detailedDates.ts` |
| Client jobs | `src/lib/tallySyncJobs.ts` |
| Resolver libs (tests + parity) | `src/lib/tallySync/*` |
| UI | `src/components/ServerReportExportPanel.tsx` |
| Tests | `src/lib/__tests__/tallySync*.test.ts` |
| Config | `supabase/config.toml` — `[functions.run-tally-sync-job]` |

## 6. Migrations

**`20261005170000_tally_sync_preparation_phase3.sql`** (repo only; not deployed unless explicitly approved):

- Extends status check with `prepared`
- Columns: `prepared_at`, `prepared_item_count`, `report_row_count`, `preparation_checkpoint`, `worker_id`, `worker_heartbeat_at`, `config_snapshot`
- Table `tally_sync_job_items`
- RPCs: `claim_tally_sync_job_v1`, `tally_sync_job_heartbeat_v1`, `store_tally_sync_job_items_chunk_v1`, `complete_tally_sync_preparation_v1`, `fail_tally_sync_job_v1`, `tally_expense_meta_batch_v1`
- Replaces `create_tally_sync_job_v1` to freeze `daily_expense_report_config` into `config_snapshot` for daily jobs

Depends on Phase 2 `20261005160000_tally_sync_jobs_phase2.sql`.

## 7. Prepared-data schema

**`tally_sync_job_items`**

| Column | Purpose |
|--------|---------|
| `job_id`, `organization_id` | Isolation + cascade delete |
| `seq` | Deterministic ordering |
| `source_type` | `expense`, `balance_timeline`, `daily_report_row` |
| `source_key` | Stable idempotency key (unique per job) |
| `content_hash` | SHA-256 of canonical payload |
| `payload` | Normalized jsonb for future Tally mapping |

RLS: SELECT via `tally_sync_admin_can_view_v1` only.

## 8. Normalized record schema

Payloads retain report/TDL-relevant fields (workflow, custom fields, balances, `source_expenses`, etc.) without Tally XML shape:

- **Claim:** full expense row from `report_expense_rows_v1` wrapped with `organization_id`, `report_type`, `expense_id`
- **Detailed:** V4 timeline row under `balance_timeline` + `event_id`
- **Daily:** authoritative grouped row + `track_date`, `user_id`, `project_id`

Client-side reference normalizers: `src/lib/tallySync/normalize.ts` (used in tests; worker stores equivalent structure).

## 9. Claim Verification resolver

- **Source:** `report_expense_rows_v1`
- **Statuses:** `verified`, `level_1_verified`, `level_2_verified` (or single status when Manager filter set)
- **Paging:** 250/page until `has_more` false; fail if `sourceExpenses !== total_count`
- **Filters:** category + user_ids via RPC; custom fields + soft-delete at Tally boundary

## 10. Claim Approval resolver

- **Source:** `report_expense_rows_v1` with `p_statuses = ['approved']`
- **HO status:** Enforced at parse — only `approved` valid for sync parameters
- **R3:** `engineer_status` → `expenses.approval_tier` via `tally_expense_meta_batch_v1` (`verified`→`engineer`, `level_1_verified`→`team_leader`, `level_2_verified`→`executive`)

## 11. Detailed Expense resolver

- **Source:** `report_detailed_expense_rows_v4` (canonical balances — not recomputed in TS)
- **Dates:** `resolveDetailedExpenseRpcDates` — explicit `date_from`/`date_to` or frozen `year`/`month`/`week` (default current year when UI enqueues year)
- **Post-fetch filter:** category + custom fields on `expense_deduction` rows only (preserves timeline for balance correctness)
- **Paging:** 500/page

## 12. Daily Project resolver

- **Source:** `report_daily_project_rows_v1`
- **Config:** Frozen `config_snapshot` at enqueue (fallback: live org settings in worker)
- **Dates:** `date_from`/`date_to` from parameters; null = all-time
- **Paging:** 250/page; schema_version check

## 13. No-filter behavior

| Report | No-filter dataset |
|--------|-------------------|
| Claim Verification | All verification-stage expenses for org (per status rules) |
| Claim Approval | All approved expenses |
| Detailed Expense | Frozen default year window when year param present |
| Daily Project | All-time when no date range |

## 14. Filtered behavior

Filters come from frozen `tally_sync_jobs.parameters` (Phase 2 capture). Worker never reads React table state.

## 15. R2 custom-field solution

Export path unchanged. Tally worker applies `custom_field_filters` after each expense page (and on detailed expense_deduction rows) using row `custom_fields` map equality.

## 16. R3 Manager Status solution

Uses real `expenses.approval_tier` from DB batch RPC — no invented status strings. Tests in `tallySyncPreparation.test.ts`.

## 17. Deleted-record rule

`report_expense_rows_v1` export unchanged. Tally preparation excludes rows where `tally_expense_meta_batch_v1` returns non-null `deleted_at`.

## 18. Pagination / batching

Page sizes match Phase 1 export worker: Claim/Daily 250, Detailed 500. Items flushed in chunks of 200 via `store_tally_sync_job_items_chunk_v1`.

## 19. Large-dataset strategy

Full paging loop without export worker’s 50s soft deadline; heartbeat updates progress. Future phases may use `preparation_checkpoint` for resumable cursors if needed.

## 20. Stable source keys

Format: `{organization_id}:{source_type}:{source_id}`

- Expense: `…:expense:{expenses.id}`
- Detailed: `…:balance_event:{event_id}`
- Daily: `…:daily_row:{track_date}|{user_id}|{project_id}`

No browser index, page number, or random UUID as source identity.

## 21. Content hash algorithm

1. Build hash input from the normalized/report row object (expense row or V4 row or daily row).
2. `stableStringify` — recursive key sort.
3. SHA-256 hex (`contentHash` in `src/lib/tallySync/contentHash.ts` and edge `_shared` copy).

Excluded from hash input: job id, worker id, seq, page number, timestamps added by worker.

## 22. Retry / idempotency

- **Job dedupe:** Phase 2 active-job dedupe (unchanged).
- **Record dedupe:** `source_key` + `content_hash` per item; chunk insert `ON CONFLICT (job_id, source_key) DO UPDATE`.
- **Retry:** `fail_tally_sync_job_v1` may re-queue; `claim` deletes items before rebuild.

## 23. Count semantics

| Field | Meaning |
|-------|---------|
| `source_row_count` | Raw rows read from report RPC before Tally-only filters (claim/detailed) or daily row count |
| `report_row_count` | Prepared items after filters (claim/detailed) or same as source for daily |
| `prepared_item_count` | Rows in `tally_sync_job_items` (must match on complete) |

## 24. Security / RLS

- Enqueue: admin only (`create_tally_sync_job_v1`)
- Read jobs/items: admin only
- Worker: `service_role` RPCs only
- No prepared payload exposure to non-admin

## 25. Status / history UI

`ServerReportExportPanel` — after Sync: triggers worker, polls job, shows **Prepared for Tally** (not “Synced to Tally”) when `prepared`.

## 26. Tests added

- `tallySyncPhase3Migration.test.ts` — SQL contract
- `tallySyncPreparation.test.ts` — filters, lifecycle, paging (>1200 rows simulated), hashes, R2/R3, no Tally I/O
- `tallySyncWorker.test.ts` — worker source references
- Updated `ServerReportExportPanel.test.tsx` — worker trigger + status copy

## 27. Test results

Run locally:

```bash
npm run test -- --run src/lib/__tests__/tallySyncPreparation.test.ts src/lib/__tests__/tallySyncPhase3Migration.test.ts src/lib/__tests__/tallySyncWorker.test.ts src/lib/__tests__/tallySyncMigration.test.ts src/lib/__tests__/tallySyncParameters.test.ts src/components/__tests__/ServerReportExportPanel.test.tsx
npm run lint
npm run build
```

Record pass/fail in your environment after migration apply (hosted DB will not have Phase 3 RPCs until deployed).

## 28. Known limitations

- No resumable checkpoint processing yet (column exists)
- Prepared items not exposed in a dedicated history grid (latest job per tab only)
- `completed` Tally delivery not implemented
- Phase 2+3 migrations not on production until approved

## 29. Rollback

1. Disable/remove `run-tally-sync-job` deploy
2. Revert migration (drop items table, restore Phase 2 status check) only if no prepared jobs needed
3. UI falls back to queue-only if worker absent (jobs stay `queued`)

## 30. Confirmation — no Tally / XML / connector / TDL

Phase 3 does **not** call TallyPrime, generate XML, ship vouchers, or build Windows connector/TDL/TCP.

## 31. Recommended Phase 4

**Tally delivery design:** connector pairing, voucher mapping from `tally_sync_job_items`, CREATE/UPDATE/SKIP using `source_key` + `content_hash`, transition `prepared` → `completed` only after confirmed delivery, cancellation/reversal for soft-deleted previously synced rows.
