# PesoWise → TallyPrime — Phase 2 Admin Sync Foundation

**Status:** Complete (repository only; migration not deployed to production)  
**Depends on:** [PHASE-01-REPORT-AUDIT.md](./PHASE-01-REPORT-AUDIT.md)

---

## 1. Phase 2 objective

Add **admin-only** “Sync to Tally” on all four Admin Reports tabs. Clicking the button creates a **`tally_sync_jobs`** row with **frozen report parameters** only. **No TallyPrime communication**, XML, connector, or worker processing in this phase.

---

## 2. Architecture

```
Reports.tsx (admin, teamScoped=false)
  └─ ServerReportExportPanel — "Report actions"
        [ Generate report ]  [ Sync to Tally ]  (admin only)
              │                      │
              │                      └─ enqueueTallySyncJob()
              │                             └─ RPC create_tally_sync_job_v1
              │                                    └─ INSERT tally_sync_jobs (status=queued)
              └─ existing report export path (unchanged)
```

---

## 3. Files changed

| Path | Change |
|------|--------|
| `supabase/migrations/20261005160000_tally_sync_jobs_phase2.sql` | Table + RLS + admin RPCs |
| `src/lib/tallyReportTypes.ts` | Canonical report type constants |
| `src/lib/tallySyncParameters.ts` | Frozen parameter builder |
| `src/lib/tallySyncJobs.ts` | Client enqueue + fetch |
| `src/components/ServerReportExportPanel.tsx` | UI + queue handler |
| `src/pages/Reports.tsx` | `enableTallySync` wiring (4 tabs) |
| `src/lib/__tests__/tallySync*.test.ts` | Unit + migration tests |
| `src/components/__tests__/ServerReportExportPanel.test.tsx` | Tally button tests |
| `src/pages/__tests__/reportsServerSideGeneration.test.ts` | Wiring tests |

---

## 4. DB migration / schema

**Table:** `public.tally_sync_jobs`

| Column | Purpose |
|--------|---------|
| `id`, `organization_id`, `requested_by` | Identity + audit |
| `report_type` | One of four canonical types |
| `parameters` | Frozen JSON context (no rows) |
| `dedupe_key` | Active job dedupe (queued/processing) |
| `status` | `queued` \| `processing` \| `completed` \| `failed` |
| `error_*` | Safe failure surface |
| `source_row_count`, … `connector_device_id` | Reserved for Phase 3+ |
| `created_at`, `started_at`, `completed_at` | Lifecycle |

**Functions:**

- `tally_sync_admin_can_view_v1(org)` — active membership **role = admin** only.
- `create_tally_sync_job_v1(org, report_type, parameters)` — SECURITY DEFINER; **42501** if not admin.

**RLS:** SELECT for org admins via `tally_sync_admin_can_view_v1`. No client INSERT/UPDATE.

---

## 5. Admin authorization

| Layer | Behavior |
|-------|----------|
| UI | `enableTallySync={userRole === "admin" && !teamScoped}` — hidden for cashier, team leaders, `/team-reports` |
| RPC | `tally_sync_admin_can_view_v1` — **does not** grant accountant cashier |
| vs reports | Stricter than `daily_report_caller_can_view_v1` (Phase 1) |

Master admin is **not** auto-enabled unless they hold org `admin` membership (same as route today).

---

## 6. Organization isolation

- `p_organization_id` validated with admin membership for `auth.uid()`.
- RLS on `tally_sync_jobs` scoped to org + admin role.
- Client never sends `requested_by`; server sets from `auth.uid()`.

---

## 7. UI implementation

- Section title: **Report actions** (same card as Generate).
- Buttons: **Generate report** | **Sync to Tally** (outline).
- Success copy: **“Tally sync job queued.”** + job id — **not** “synced to Tally”.
- Loading state on button; server dedupe collapses identical active jobs.

---

## 8. Four report integrations

All use `ServerReportExportPanel` with shared enqueue path; `reportType` drives `daily_project_report` vs expense types.

---

## 9. No-filter behavior (frozen parameters)

| Report | Parameters when filters at defaults |
|--------|-------------------------------------|
| Claim Verification | `{}` + `context_version` (+ export_parity metadata) |
| Claim Approval | `ho_status` omitted when default; inherent approved dataset implied by report type |
| Detailed Expense | `year` = selected year (UI default current year), `date_from`/`date_to` = full year |
| Daily Project | No `date_from`/`date_to` when period = **all_time** |

---

## 10. Filtered behavior

Same keys as report export where applicable, plus:

- `custom_field_filters` — captured for **Verification/Approval** (even though report export ignores them today).
- `ho_status` — captured on Approval tab.
- `engineer_status`, `category`, `user_id`, date keys, year/month/week — stored in `parameters` at click time.

Jobs are immutable; UI filter changes afterward do not alter existing rows.

---

## 11. Canonical report context

- Types: `src/lib/tallyReportTypes.ts` (`TALLY_SYNC_REPORT_TYPES`).
- Builder: `buildTallySyncParameters()` — **no rows, pages, or preview fields**.
- `context_version: 1` for forward compatibility.

---

## 12. Parameter mapping per report

| Report | Parameters (when set) |
|--------|------------------------|
| claim_verification | `category`, `user_id`, `user_ids`, `engineer_status`, `custom_field_filters`, `export_parity` |
| claim_approval | above + `ho_status`, `export_parity.claim_approval_engineer_status_in_report_export: false` |
| detailed_expense | `user_id`, `user_ids`, `category`, `date_from`, `date_to`, `year`, `month`, `week`, `custom_field_filters` |
| daily_project_report | `user_id`, `user_ids`, `date_from`, `date_to` |

---

## 13. Job lifecycle (Phase 2)

- Created in **`queued`** only.
- No worker claims jobs yet.
- States `processing` / `completed` / `failed` reserved for Phase 3+.

---

## 14. Error handling

- RPC `42501` → UI toast “Tally sync failed” with message.
- Unsupported report type rejected in SQL.
- No stack traces or secrets exposed in UI.

---

## 15. Tests added

- `tallySyncParameters.test.ts` — no-filter / filtered / no rows in payload.
- `tallySyncMigration.test.ts` — admin-only SQL contract.
- `ServerReportExportPanel.test.tsx` — button visibility + enqueue.
- `reportsServerSideGeneration.test.ts` — four-tab wiring.

---

## 16. Tests executed

Run locally:

```bash
npm run test -- --run src/lib/__tests__/tallySyncParameters.test.ts src/lib/__tests__/tallySyncMigration.test.ts src/components/__tests__/ServerReportExportPanel.test.tsx src/pages/__tests__/reportsServerSideGeneration.test.ts
```

**2026-10-05 local run:** 33 + 39 = **72 tests passed** (`tallySyncParameters`, `tallySyncMigration`, `reportsServerSideGeneration`, `ServerReportExportPanel`). Migration SQL not applied on production.

---

## 17. Phase 1 risks still open

| ID | Status in Phase 2 |
|----|---------------------|
| R1 deleted_at on claim reports | **Unchanged** — documented for Phase 3 dataset processor |
| R4 worker timeout | N/A until Tally worker |
| R7 preview ≠ full dataset | Tally path does not use preview |

---

## 18. R2 / R3 filter parity

| Issue | Phase 2 action |
|-------|----------------|
| **R2** Custom fields on Claim tabs not in report export | **Captured** in `parameters.custom_field_filters` + `export_parity.custom_field_filters_in_report_export: false`. Phase 3 must apply filters when resolving rows. |
| **R3** Approval Manager Status ignored by export | **Captured** as `engineer_status` + `export_parity.claim_approval_engineer_status_in_report_export: false`. Phase 3 must decide parity vs export. |

Report **Generate** behavior was **not** changed.

---

## 19. Deleted-record behavior

Still **not** filtering `deleted_at` in `report_expense_rows_v1`. Phase 3 must align Tally dataset rules with product decision (likely match Detailed V4).

---

## 20. Intentionally NOT implemented

- TallyPrime / localhost:9000 / XML / vouchers / ledgers
- Windows connector / WebSocket / pairing
- TDL / TCP
- Tally sync worker / processing state transitions
- Production deploy

---

## 21. Rollback

1. Revert application commit.
2. If migration was applied locally only: drop `create_tally_sync_job_v1`, `tally_sync_admin_can_view_v1`, table `tally_sync_jobs` (no other tables depend on it).

---

## 22. Recommended Phase 3

1. Apply migration to staging Supabase.
2. Implement **Tally sync worker** (claim jobs, resolve full dataset using same RPCs as report export + R2/R3 parity rules).
3. Add admin-only status/history UI for `tally_sync_jobs`.
4. Define idempotency store keyed by Phase 1 stable IDs.
5. Only after that: Tally XML/connector phases.
