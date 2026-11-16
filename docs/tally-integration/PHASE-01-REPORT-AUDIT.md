# PesoWise → TallyPrime Integration — Phase 1 Report Audit

**Phase:** 1 (audit + documentation only)  
**Date:** 2026-10-05  
**Scope:** Four admin reports on `/admin/reports` (and team-scoped mirror on `/team-reports`)  
**Functional code changes in Phase 1:** None

---

## 1. Executive Summary

PesoWise admin reports are centered on `src/pages/Reports.tsx`. **Primary production path:** server-side generation via `ServerReportExportPanel` → `report_export_jobs` queue → Edge Function `run-report-export-job` → CSV in Storage `generated-reports` → signed download via `get-report-export-download-url`.

| Report | Primary data source | Full-dataset mechanism | On-screen table |
|--------|---------------------|------------------------|-----------------|
| Claim Verification List | `report_expense_rows_v1` | Worker pages 250 rows; fail-closed on count mismatch | No live table (client query disabled) |
| Claim Approval List | `report_expense_rows_v1` | Same | No live table |
| Detailed Expense Report | `report_detailed_expense_rows_v4` | Worker pages 500 rows; post-filter in worker | Preview only (50 rows/page, Detailed only) |
| Daily Project Report | `get_daily_project_report_page_v1` / `report_daily_project_rows_v1` | Client coordinator + worker both page 250; fail-closed | Full in-browser table after paged load |

Legacy client-side export helpers (`exportVerificationList`, etc.) remain in `Reports.tsx` but **no UI button calls them**; they depend on React Query loaders that are **`enabled: false`**, so they would export empty data if invoked.

**Recommended future Tally boundary:** Reuse the **same enqueue parameters + worker row producers** (`report_expense_rows_v1`, `report_detailed_expense_rows_v4`, `report_daily_project_rows_v1`) — not browser preview pagination and not legacy client export functions.

---

## 2. Current Report Architecture

```
Admin UI: Reports.tsx (+ TeamReports.tsx teamScoped=true)
    │
    ├─ Filters (React state) ──► enqueue RPCs (authenticated)
    │       create_expense_report_export_job_v1  (claim_*, detailed_expense)
    │       create_daily_project_report_export_job_v1  (daily_project_report)
    │
    ├─ ServerReportExportPanel.tsx
    │       triggerExportWorker → supabase.functions.invoke("run-report-export-job")
    │       poll report_export_jobs
    │       download → get-report-export-download-url
    │
    └─ Daily tab only: dailyQuery → runDailyProjectReportExport (client pages get_daily_project_report_page_v1)

Worker: supabase/functions/run-report-export-job/index.ts
    ├─ claim_report_export_job_v1 / v2 (service_role)
    ├─ report_expense_rows_v1 + expenseReports.ts (Claim Verification/Approval)
    ├─ report_detailed_expense_rows_v4 + expenseReports.ts (Detailed)
    └─ report_daily_project_rows_v1 (Daily export job path)

Auth gate (DB): daily_report_caller_can_view_v1(org_id, team_scoped)
RLS: report_export_jobs SELECT via same helper (+ requester membership fallback)
```

**Tables (core):** `expenses`, `profiles`, `expense_batches`, `expense_form_field_values`, `expense_categories`, `organization_settings.daily_expense_report_config`, `cash_transfer_history`, `balance_ledger` / `expense_balance_deductions` (via timeline), `report_export_jobs`, `report_export_job_rows` (Detailed preview chunks).

**No separate REST “reports API”** beyond Supabase RPC + Edge Functions.

---

## 3. Claim Verification List

### 3.1 Frontend

| Item | Location |
|------|----------|
| Page | `src/pages/Reports.tsx` — tab `verification` |
| Route | `/admin/reports` — `App.tsx` `ProtectedRoute allowedRoles={["admin"]} allowAccountantCashier` |
| Export UI | `ServerReportExportPanel` `reportType="claim_verification"` |
| Legacy loader | `loadVerificationReport()` — query **`enabled: false`** |
| Legacy balances | `computeRowBalancesForVerification()` (mirrored in worker) |

**Card copy:** “Expenses verified by managers, pending admin approval.”

### 3.2 Inherent business rules (not optional filters)

- `expenses.organization_id = <current org>`
- Status ∈ `{ verified, level_1_verified, level_2_verified }` unless Manager Approval filter narrows to one status (server: `buildExpenseReport` in worker)
- **Not applied in `report_expense_rows_v1`:** `deleted_at IS NULL` (see §21)
- HO Approval column in export is **always** `"Pending"` (presentation rule for this report type)

### 3.3 Optional filters (UI → job `parameters` jsonb)

| Filter | Default | “All” meaning | Backend field | Server export? |
|--------|---------|---------------|---------------|----------------|
| Employee | `all` | All org users (or team members if team-scoped) | `user_id` or `user_ids` | Yes |
| Expense Type | `all` | Any category | `category` (ILIKE) | Yes |
| Manager Approval Status | `all` | All three verified statuses | `engineer_status` → worker status list | Yes |
| Custom fields | `all` per field | — | — | **No** (UI only; not passed to `ServerReportExportPanel`) |

Date filters: **none** on this tab (`dateFrom`/`dateTo` always `null`).

### 3.4 Sorting / columns / calculations

- **Sort (server):** `created_at DESC`, `id DESC` (`report_expense_rows_v1`, default sort column)
- **Opening/Closing balance:** TypeScript in worker — `balancesForVerification()` in `expenseReports.ts` (port of `computeRowBalancesForVerification`); uses `profiles.balance` per row batch
- **CSV columns:** `CLAIM_HEADERS_FIXED` + dynamic custom-field keys + Opening/Closing Balance — `buildClaimCsv()` in `expenseReports.ts`

### 3.5 Pagination / full dataset

- Worker: `fetchAllExpenseRows()` loops `report_expense_rows_v1` with `p_page_size=250`, `p_with_total` on first page; throws if `rows.length !== total_count`
- **PostgREST 1000-row cap bypassed** (jsonb RPC envelope, service_role)
- Edge soft deadline **50s** → `REPORT_TOO_LARGE_MESSAGE` (job fails, retryable flag false for that message)
- Preview: **not supported** for this report type

### 3.6 Stable IDs

- **Primary:** `expenses.id` (UUID)
- **Related:** `expenses.user_id`, `expenses.batch_id`, `organization_id`, `transaction_number` (display)

---

## 4. Claim Approval List

### 4.1 Frontend

| Item | Location |
|------|----------|
| Tab | `approval` in `Reports.tsx` |
| Export | `ServerReportExportPanel` `reportType="claim_approval"` |
| Legacy loader | `loadApprovalReport()` — **`enabled: false`** |

**Card copy:** “Expenses approved by admin.”

### 4.2 Inherent business rules

- `organization_id` scoped
- **`status = 'approved'`** only (worker `REPORT_STATUSES.claim_approval`)
- HO Approval UI shows only **Approved** (single option); export cell **always** `"Approved"`
- Manager Approval column in CSV always **"Verified"** (presentation)

### 4.3 Optional filters

| Filter | Default | Server export? | Notes |
|--------|---------|----------------|-------|
| Employee | `all` | Yes | |
| Expense Type | `all` | Yes | |
| Manager Approval Status | `all` | **No effect** | Worker ignores `engineer_status` when `reportType !== claim_verification` |
| HO Approval Status | `approved` | **No effect** | Inherent `approved` status already enforced |
| Custom fields | — | **No** | UI shown; not enqueued |

No date filters.

### 4.4 Calculations

- **Balances:** `balancesForApproval()` — backward walk from current profile balance (`expenseReports.ts`)

### 4.5 Pagination / full dataset

Same as Claim Verification (`report_expense_rows_v1`, 250/page, count check, 50s deadline).

### 4.6 Stable IDs

Same as Claim Verification (`expenses.id`).

---

## 5. Detailed Expense Report

### 5.1 Frontend

| Item | Location |
|------|----------|
| Tab | `detailed` in `Reports.tsx` |
| Date derivation | `computeDetailedExpenseDateRange()` — `src/lib/detailedExpenseReportFilters.ts` |
| Export | `ServerReportExportPanel` with `dateFrom`/`dateTo`, `customFieldFilters`, year/month/week metadata |
| Legacy loader | `loadDetailedReport()` — **`enabled: false`** |
| Mobile | `MobileDetailedExpenseReportView` (separate; uses disabled query data if ever enabled) |

**Inherent rule (card):** “Approved expenses only, with balance tracking” — implemented as **canonical balance timeline**, not a raw expense list.

### 5.2 Inherent business rules

- Organization scoped
- Timeline from `report_detailed_expense_rows_v4` (V4): all **approved** expenses with valid profile, **`e.deleted_at IS NULL`** in V4 SQL
- Non-expense events (credits, transfers, opening balance, etc.) from `_balance_timeline_events_v3`
- Legacy approved expenses **without** `expense_balance_deductions`: shown with **Debit display** but **zero balance delta** (`modern_deduction_present=false`)

### 5.3 Optional filters

| Filter | Default | Backend | Server export |
|--------|---------|---------|---------------|
| Employee | `all` | `user_id` / `user_ids` | Yes (dataset scope) |
| Expense Type | `all` | Post-fetch filter | Yes (`matchesDetailedExpenseFilters`) |
| Year | current calendar year | `date_from`/`date_to` via `computeDetailedExpenseDateRange` | Yes |
| Month | `all` | narrows date range | Yes |
| Week | `all` | ISO week range; **overrides month** | Yes |
| Custom fields | `all` | `custom_field_filters` in job | Yes (post-fetch on expense_deduction rows only) |

**Important:** Category/custom filters **do not** re-query SQL; full timeline fetched for date/user scope, then rows filtered in worker memory so **running balances stay correct**.

### 5.4 Sorting / columns / calculations

- **Balances:** computed in SQL (`opening_balance`, `closing_balance`, `amount_delta`, credit/debit columns) — **not** in TypeScript
- **CSV builder:** `buildDetailedRows()` in `expenseReports.ts` — shared by CSV and stored preview rows
- **Columns:** Employee, Employee ID, Date, Transaction #, Title, Type, Expense Type, Purpose, Destination, Batch, custom fields, Credit, Debit, Notes, Opening/Closing Balance

### 5.5 Pagination / full dataset

- Worker: `fetchAllDetailedExpenseRowsV4()` — **500 rows/page**, count mismatch fails job
- Preview: `fetchReportExportJobPreviewPageV2` — **50 rows/page**; sort/filter on preview is **UI-only over stored snapshot**, not the sync dataset
- Soft deadline 50s applies

### 5.6 Stable IDs

| Row kind | IDs |
|----------|-----|
| Timeline event | `event_id` (uuid), `event_type` |
| Expense-shaped row | `expense_id` (nullable for non-expense events) |
| Employee | `user_id`, `employee_code` |
| Transfer/credit events | underlying ledger/transfer ids inside SQL (surfaced as `event_id`) |

---

## 6. Daily Project Report

### 6.1 Frontend

| Item | Location |
|------|----------|
| Tab | `daily` (gated by org feature `daily_project_expense_report`) |
| Config | `fetchOrganizationDailyReportConfig()` — `organization_settings.daily_expense_report_config` |
| On-screen load | `loadDailyReport()` → `runDailyProjectReportExport()` — `src/lib/dailyProjectReportPaging.ts` |
| Shaping | `dailyReportResultsToRows()` — `src/lib/buildDailyProjectExpenseReport.ts` |
| Client export buttons | CSV/XLSX from **currently loaded** `dailyReportRows` |
| Background export | `ServerReportExportPanel` (no `reportType` → daily job) |

### 6.2 Inherent business rules

- Feature flag must be enabled
- Admin config must be “ready” (`isDailyReportConfigReady`)
- **`expenses.status = 'approved'`** in shared core SQL (`20260827160000_daily_project_report_shared_core.sql`)
- Project/location/cost buckets from **org config** (not user filters)
- Grouping key: `(track_date, user_id, project_id)` — see `dailyReportRowIdentity()`

### 6.3 Optional filters

| Filter | Default | Backend | Client on-screen | Server export job |
|--------|---------|---------|------------------|-------------------|
| Period | `all_time` | null dates | Yes | Yes |
| Date range | month-start → today when custom | `date_from`/`date_to` | Yes | Yes |
| Employee | `all` | `user_id` / `user_ids` | Yes | Yes |
| Team scope | false on admin route | `team_scoped`, `user_ids` from My Teams | N/A on `/admin/reports` | Yes |

No category/custom-field filters on this report.

### 6.4 Calculations

- **Server:** grouping, cost column mapping, percent split, remarks — `report_daily_project_rows_v1` + config snapshot on job row
- **Client:** locale sort + workbook layout (`finalizeDailyReportGroups` parity documented in worker comments)
- **Headers:** `DAILY_PROJECT_REPORT_HEADERS` in `dailyExpenseReportConfig.ts`

### 6.5 Pagination / full dataset

| Path | Page size | Full dataset |
|------|-----------|--------------|
| Browser | 250 (`DAILY_REPORT_PAGE_SIZE`), max 500 | Loops until `hasMore=false`; **aborts if assembled count ≠ total_count** |
| Export worker | 250 | Same core RPC; same fail-closed |
| PostgREST | N/A for page RPC | Avoids old 1000-row silent truncate |

Underlying expenses exposed per row in `source_expenses[]` (includes `expenses.id`).

### 6.6 Stable IDs

- **Report row identity:** `(track_date, user_id, project_id)` string from `dailyReportRowIdentity()`
- **Source expenses:** `source_expenses[].id` (expense UUIDs)
- **Organization:** `organization_id`

---

## 7. Complete Filter Matrix

See §3.3, §4.3, §5.3, §6.3. Summary:

| Filter | Verification | Approval | Detailed | Daily |
|--------|:------------:|:--------:|:--------:|:-----:|
| Organization | inherent | inherent | inherent | inherent |
| Employee | opt | opt | opt | opt |
| Expense type | opt | opt | opt | — |
| Manager/engineer status | opt | UI only* | — | — |
| HO status | — | UI only* | — | — |
| Year/month/week | — | — | opt | — |
| Date range | — | — | via Y/M/W | opt |
| Custom fields | UI only | UI only | opt | — |
| Team membership | team route | team route | team route | team route |

\*Not applied by server export for Approval tab.

---

## 8. No-Filter Behavior (per report)

| Report | Complete unfiltered dataset means |
|--------|----------------------------------|
| Claim Verification | All org expenses in verified / L1 / L2 verified statuses, all employees, all categories |
| Claim Approval | All org **approved** expenses |
| Detailed Expense | All employees; date range = **selected year** (Jan 1–Dec 31) — year defaults to **current year**, not “all time” |
| Daily Project | **All time** approved expenses (default period mode), all employees, config-driven project/cost mapping |

Team-scoped `/team-reports`: same filters but population restricted to **My Teams member user IDs** (`fetchTeamMemberUserIds` / `user_ids` on jobs).

---

## 9. Filtered Behavior

Filters are frozen into `report_export_jobs.parameters` at enqueue time (`create_*_export_job_v1`). Dedupe key includes full parameters JSON (org-wide for expense reports; daily job includes requester per migration family).

Changing UI filters after enqueue does **not** alter a running/completed job. Retry uses frozen parameters (`retryReportExportJob`).

---

## 10. Pagination / Full-Dataset Behavior

| Mechanism | Limit | Notes |
|-----------|-------|-------|
| Legacy PostgREST `.from("expenses").select()` | ~1000 default max | **Disabled** for first three reports |
| `report_expense_rows_v1` | 250–500/page | service_role; total_count on page 1 |
| `report_detailed_expense_rows_v4` | up to 500/page | |
| `get_daily_project_report_page_v1` | 250 default, 500 max | authenticated |
| Worker wall clock | ~50s soft | Large orgs may need narrower filters or future chunking |
| Preview (Detailed) | 50/page | **Not** authoritative for sync |

**Future Tally sync must use the same paging loops as the worker/coordinator**, not preview tables.

---

## 11. Database Functions (authoritative list)

| Function | Role |
|----------|------|
| `daily_report_caller_can_view_v1` | Authorization |
| `create_expense_report_export_job_v1` | Enqueue claim/detailed |
| `create_daily_project_report_export_job_v1` | Enqueue daily |
| `report_expense_rows_v1` | Claim rows (worker) |
| `report_detailed_expense_rows_v4` | Detailed timeline (worker) |
| `report_balance_timeline_rows_v3` | Legacy V3 producer (not used by current Detailed worker) |
| `_balance_timeline_events_v3` | Shared accounting events |
| `get_daily_project_report_page_v1` | Daily pages (authenticated UI) |
| `report_daily_project_rows_v1` | Daily pages (worker) |
| `get_daily_report_project_name_ambiguity_batch_v2` | Daily name ambiguity |
| `_report_expense_custom_fields_v1` | Custom fields on expense rows |
| `list_report_export_jobs_v4` | History |
| `get_report_export_job_preview_v3` / preview v2 | Detailed preview pages |
| `claim_report_export_job_v1` / `v2` | Worker claim |
| `complete_report_export_job_v1` / `fail_report_export_job_v1` | Worker lifecycle |

---

## 12. Existing APIs / Services (client)

| Module | Purpose |
|--------|---------|
| `src/lib/reportExportJobs.ts` | Enqueue, poll, download, history, preview |
| `src/components/ServerReportExportPanel.tsx` | Generate UX |
| `src/lib/dailyProjectReportPaging.ts` | Daily full fetch coordinator |
| `src/lib/exportDailyProjectExpenseReport.ts` | Daily XLSX/CSV from rows |
| `supabase/functions/run-report-export-job` | Generation |
| `supabase/functions/get-report-export-download-url` | Authorized signed URL |

---

## 13. Calculation Source of Truth

| Report | Authoritative logic | Duplicated / legacy |
|--------|---------------------|---------------------|
| Claim Verification | Worker `balancesForVerification` + `report_expense_rows_v1` | Client copies exist but queries disabled |
| Claim Approval | Worker `balancesForApproval` | Same |
| Detailed Expense | SQL timeline V4 + `buildDetailedRows` | Client `detailedListWithBalances` **stale path** (disabled query) |
| Daily Project | `report_daily_project_rows_v1` / `get_daily_project_report_page_v1` | Client finalize/sort only |

**Excel/CSV parity:** Primary downloads are **CSV from worker**. Daily tab additionally builds XLSX client-side from loaded rows (same paging coordinator as on-screen table when load succeeded).

---

## 14. Web vs Excel/Export Comparison

| Report | On-screen data | Download |
|--------|----------------|----------|
| Claim Verification / Approval | None (server panel only) | Worker CSV |
| Detailed | Optional preview (50/pg, stored rows) | Worker CSV (same `buildDetailedRows`) |
| Daily | Full paged table in browser | CSV/XLSX from loaded rows **or** worker CSV job |

Legacy multi-format dialog (`exportDialogOpen`) is **unreachable** from UI (no `openExportDialog` calls).

---

## 15. Stable Record IDs (future dedupe)

| Report | Dedupe key candidates |
|--------|------------------------|
| Claim Verification / Approval | `expenses.id` |
| Detailed Expense | `event_id` (+ `expense_id` when `event_type = expense_deduction`) |
| Daily Project | Composite `(track_date, user_id, project_id)` plus constitutive `expenses.id[]` in `source_expenses` |

Always include `organization_id` in any external sync ledger.

---

## 16. Edit / Delete / Lifecycle

- Expenses: editable through normal app workflows; statuses progress toward `approved` or rejection/withdrawal paths (report filters select subsets).
- **Recycle bin:** `deleted_at` / `purge_after` on `expenses` — **Detailed V4 excludes deleted**; **Claim row producer does not filter `deleted_at`** (gap).
- Approved expenses can be corrected via admin/reviewer RPCs (outside report code); reports are point-in-time snapshots at generation.
- Balance events can include reversals per V3 timeline rules (Detailed).
- Daily report only includes **approved** expenses at SQL level.

---

## 17. Admin Authorization

| Layer | Mechanism |
|-------|-----------|
| Route | `/admin/reports`: `ProtectedRoute` roles `admin` + `allowAccountantCashier` (accountant-mode cashier) |
| UI | `useCashierCapabilities().canAccessReports` |
| DB | `daily_report_caller_can_view_v1(org, false)` → admin **or** accountant cashier with `cashier_accountant_mode` feature |
| Team reports | `/team-reports`: engineer/team_leader/executive; DB check `team_scoped=true` allows those roles |
| Master admin | `userRole === "master_admin"` in auth context — **not** in admin reports route allow-list (master admin uses separate flows) |
| Worker | Trusts enqueue-time auth; uses `service_role` without re-checking user |

**Future Tally sync:** extend same `daily_report_caller_can_view_v1` (admin-only variant if product requires stricter than accountant cashier).

---

## 18. Organization Isolation

- All enqueue RPCs require `p_organization_id` and validate membership via `daily_report_caller_can_view_v1`.
- Row producers filter `expenses.organization_id = p_organization_id` (or equivalent in timeline functions).
- `report_export_jobs.organization_id` scoped; RLS SELECT uses viewer helper.
- Storage path `{orgId}/{jobId}/{filename}`; download function re-checks job access.
- Worker claim by job id prevents cross-org drain when UI sends `job_id`.
- Team scope passes explicit `user_ids` array derived from server RPC (`list_my_teams_overview`), not client-supplied arbitrary IDs without membership checks on admin path (admin uses org-wide lists).

**No critical cross-org bypass identified** in report export path during this audit.

---

## 19. Tally Persistence Requirements (documentation only)

### Claim Verification / Approval (expense-centric)

| Field class | Examples | Tally direction |
|-------------|----------|-----------------|
| Accounting | Bill Amount, Opening/Closing Balance | Voucher amounts / running balance context |
| Workflow | Status, Manager/HO Approval columns | Narration or custom tracking (not standard Tally masters) |
| Dimensions | Employee, Expense Type, Purpose, Destination, custom fields | Cost centre / ledger narration |
| Metadata | Transaction #, Batch, Submitted date | Reference / narration |
| Stable keys | `expenses.id`, `organization_id` | External sync id map (future) |

### Detailed Expense (ledger-centric)

| Field class | Examples |
|-------------|----------|
| Accounting | Credit, Debit, Opening/Closing Balance |
| Event typing | `event_label`, `event_type` |
| Expense slice | Expense Type, Purpose, custom fields (expense rows only) |
| Stable keys | `event_id`, `expense_id` |

### Daily Project (aggregated project-day)

| Field class | Examples |
|-------------|----------|
| Accounting | Cost columns (Petrol, Material, …), percent |
| Dimensions | project id/name, Employee, Location, Track Date |
| Drill-down | `source_expenses` list |
| Stable keys | `(track_date, user_id, project_id)` + expense ids |

TDL/report layout in Tally is **out of scope** (manual user work).

---

## 20. Recommended Future Integration Boundary

1. **Trigger:** New admin-only action alongside existing **Generate** (future phase).
2. **Input:** Identical parameter object as `create_expense_report_export_job_v1` / `create_daily_project_report_export_job_v1` (frozen snapshot).
3. **Execution:** Server-side job pattern (queue + worker) — **never** browser-visible page slices.
4. **Row producers:** Reuse `report_expense_rows_v1`, `report_detailed_expense_rows_v4`, `report_daily_project_rows_v1` (or invoke existing worker pipeline and transform CSV → Tally format in a new worker step).
5. **Auth:** `daily_report_caller_can_view_v1` restricted to admin if required.
6. **Dedupe:** Org-level idempotency store keyed by report type + parameters + stable source ids (future phase).

---

## 21. Risks / Blockers

| ID | Risk | Severity |
|----|------|----------|
| R1 | Claim reports (`report_expense_rows_v1`) omit `deleted_at IS NULL` — trashed expenses may appear | Medium |
| R2 | Custom field filters on Verification/Approval UI **not** in server export | High for “filtered sync” parity |
| R3 | Approval tab Manager Status filter does not affect export | Medium (UX mismatch) |
| R4 | Worker **50s** soft timeout — very large org + wide filters may fail | Medium |
| R5 | Detailed legacy expenses show **zero balance delta** — Tally totals may not match wallet | Medium (documented product rule) |
| R6 | Daily client XLSX/CSV uses in-memory rows — must match coordinator completeness; worker path safer for huge exports | Low |
| R7 | Preview pagination ≠ full dataset — must not drive Tally | High if misused |
| R8 | Accountant cashier can generate reports today — may be broader than “admin only” Tally requirement | Product decision |

---

## 22. Files Inspected

- `src/pages/Reports.tsx`
- `src/pages/TeamReports.tsx` (wrapper)
- `src/components/ServerReportExportPanel.tsx`
- `src/lib/reportExportJobs.ts`
- `src/lib/detailedExpenseReportFilters.ts`
- `src/lib/dailyProjectReportPaging.ts`
- `src/lib/buildDailyProjectExpenseReport.ts`
- `src/lib/exportDailyProjectExpenseReport.ts`
- `src/lib/dailyExpenseReportConfig.ts`
- `src/lib/teamReportsScope.ts`
- `src/hooks/useCashierCapabilities.ts`
- `src/App.tsx`
- `src/components/ProtectedRoute.tsx`
- `supabase/functions/run-report-export-job/index.ts`
- `supabase/functions/run-report-export-job/expenseReports.ts`
- `supabase/functions/get-report-export-download-url/index.ts`
- Migrations: `20260820160000_daily_project_report_server_pagination.sql`, `20260827150000_report_export_jobs.sql`, `20260827160000_daily_project_report_shared_core.sql`, `20260827170000_server_side_expense_reports.sql`, `20260902130000_report_balance_timeline_v3.sql`, `20260926000000_detailed_expense_rows_v4.sql`, `20260922120000_expense_recycle_bin_v1.sql`, `20261001000000_report_export_queue_v2.sql`, `20261017000000_daily_project_report_export_job_v1.sql`
- Tests referenced: `src/pages/__tests__/reportsServerSideGeneration.test.ts`, `src/lib/__tests__/reportExportWorker.test.ts`

---

## 23. Phase 1 Confirmation

**No functional code changes were made in Phase 1.**  
Only this document was added under `docs/tally-integration/`.

---

## 24. Next Phase (Phase 2 — not started)

**Phase 2 — Integration requirements & mapping spec (still no Tally XML/TDL/production deploy):**

- Product decisions on R2, R3, R8 (filter parity, admin-only).
- Canonical **parameter JSON schema** per report aligned with enqueue functions.
- **Field-level mapping** tables: PesoWise column → Tally voucher/ledger concept.
- **Idempotency model** design (`expenses.id`, `event_id`, daily composite key).
- **Job type** design (`report_export_jobs` extension vs new `tally_sync_jobs`).
- Acceptance criteria for “no filters” vs “filtered” using worker row counts, not preview.

Await explicit approval before Phase 2.
