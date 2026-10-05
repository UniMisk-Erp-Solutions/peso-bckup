# Detailed Expense Report — Format Parity, On-Page Preview, History Pagination

**Doc ID:** DOC-131
**Status:** in progress — **backend live in Production, frontend NOT yet merged/deployed**
**Last updated:** 2026-09-25
**Owner / area:** Reports (Detailed Expense)

> **BACKEND MIGRATION APPLIED 2026-09-23 10:04 UTC.** The additive
> `20260924000000_detailed_expense_report_preview_v1.sql` migration is now
> live on the shared Production database (backup taken first:
> `20260923T100449Z-pre-detailed-expense-preview-migration.dump`, SHA-256
> `b9cf8eff6455efeb21fa61704910e9da431681606b75a6cef48629c52aecfed5`,
> verified via `pg_restore --list`, 2529 TOC entries / 117 `TABLE DATA`).
> Live schema, grants (anon confirmed with ZERO access to every new object —
> this migration was written with the explicit `REVOKE ... FROM anon`
> pattern from the start, so no follow-up hardening migration was needed
> this time), authorization, pagination, immutability, retry, and
> failed-generation behavior were all independently re-verified against the
> live database in a rolled-back transaction (zero permanent footprint —
> see §9a). **This is a backend-only change: `list_report_export_jobs_v1`
> is untouched and still live, the Production frontend still only calls
> that path, and it was confirmed healthy (loads, no console errors) after
> the apply. The new preview/pagination frontend has NOT been merged to
> `main` or deployed — only the branch's own Preview deployment can use
> it.** See §9a for the full record.
>
> **OWNER QA FIX PASS — SAME DAY.** The Production `run-report-export-job`
> Edge Function was found to be stale (last deployed 2026-09-05, predating
> every DOC-131 change) and has been redeployed to match this branch. Also
> fixed: a base-field memory render-path gate that depended on data arrival
> instead of the feature flag, an unwired batch-form memory fetch, a fully
> dead Week filter, Expense Type/custom-field filters that never reached
> the Detailed Expense worker, a filename that used today's date instead of
> the report's own range, and a Report History with no per-job parameter
> summary (new additive `list_report_export_jobs_v3`). See §9b for the full
> root-cause record.
>
> **FINAL INTEGRATED QA POLISH — 2026-09-25 (see §9g).** Blanks-last v3 preview RPC, newest-request-wins guard, menu closes on sort, clearer table/popover/history styling; month filter verified.
>
> **MICROLINK REPORT FAILURE FIX — 2026-09-24 (see §9f).** Every Detailed
> Expense CSV written since the 2026-09-23 worker deploy was header-only (a
> local `toCsv` shadowed the shared one); fixed, plus a 60 s platform-limit
> deadline correction, targeted job claim, all-status history and reload-safe
> failed/queued/running job visibility.
>
> **FINAL PREVIEW UX + MEMORY PROVENANCE PASS — 2026-09-23.** Excel-style
> server-side sort/filter over the entire frozen report
> (`get_report_export_job_preview_v2`, live in Production) and a Report
> History "View" control (`activePreviewJobId`) that loads any older job's
> own frozen preview without disturbing the current generation. See §9e.

---

## 1) Summary

Three related fixes to the Reports → Detailed Expense Report tab:

1. **Format parity**: selecting a single employee no longer changes the
   report's column schema — it only filters which rows are included.
   "All employees" and "Employee = X" are now byte-for-byte the same format.
2. **On-page preview**: once a report finishes generating, its rows appear
   directly on the page as a paginated table (50 rows/page) — the user does
   not have to download the CSV just to look at it.
3. **Report History pagination**: history moves from a flat top-20 fetch to
   a real 5-per-page pager with Previous / Page X of Y / Next.

All three build on the existing server-side report job queue
(`report_export_jobs`, DOC-106) — nothing about that queue's lifecycle,
authorization model, or CSV output path changed; this only adds a read-side
preview and better-paginated history on top of it.

---

## 2) Problem / requirement

- A prior version of `buildDetailedCsv` dropped the `Employee`/`Employee ID`
  columns whenever a single employee was selected (`singleUserId ? [] : [...]`).
  This silently made "All employees" and "Employee = X" two different report
  formats — selecting an employee should only ever change which rows are in
  scope.
- The Detailed Expense tab had no way to inspect a generated report without
  downloading it, and a report can be 20,000+ rows.
- Report History had no pagination — a flat top-20 (or top-100 at most) list
  with no total count, so "Page X of Y" couldn't be rendered even if wanted.

---

## 3) Solution

### 3a. Format parity (`expenseReports.ts`)

`buildDetailedCsv(rows, singleUserId)` → `buildDetailedRows(rows)` (no
`singleUserId` parameter at all — there is no longer a decision to make).
`Employee`/`Employee ID` are always in the header list. `buildDetailedCsv`
is now a one-line wrapper: `toCsv(...buildDetailedRows(rows))`. Selecting an
employee changes which rows `report_balance_timeline_rows_v3` returns
(`p_user_ids: [singleUserId]`); it was never a column-schema decision and no
longer looks like one.

### 3b. On-page preview — why a stored row set, not a live re-query

`report_balance_timeline_rows_v3` computes each employee's Opening/Closing
Balance **backwards from `profiles.balance`** — the live wallet balance — at
query time. It has no snapshot-boundary parameter. If the employee's live
balance changes for any reason after a report is generated (a new expense
approved, a transfer credited), re-running the identical query later would
silently produce **different** Opening/Closing Balance values for the same
historical rows. A live re-query preview could therefore disagree with the
file the user already downloaded — exactly the drift this feature must not
have.

So the worker instead **freezes the exact row objects it already builds for
the CSV** into a new table, `report_export_job_rows` (`job_id, row_index,
row_data jsonb`), at the same time it uploads the file. The preview reads
that frozen set back, paginated. Preview and export are the same computed
data by construction — not two independent derivations that happen to agree
today.

```
fetchAllBalanceTimelineRows()
        │
        ▼
buildDetailedRows(rows)  →  { headers, rows }
        │                         │
        ▼                         ▼
   toCsv(...) → upload      storeDetailedExpensePreview()
        │                         │
        ▼                         ▼
   report_export_jobs        report_export_job_rows
   .storage_path              (frozen, paginated)
```

New RPCs (migration `20260924000000_detailed_expense_report_preview_v1.sql`):

- `store_report_export_job_preview_chunk_v1(p_job_id, p_start_index,
  p_columns, p_rows)` — `service_role` only. One call per chunk (500 rows),
  never one call per row. `ON CONFLICT (job_id, row_index) DO UPDATE`, so a
  retried job's re-write overwrites in place rather than duplicating.
- `clear_report_export_job_preview_v1(p_job_id)` — `service_role` only,
  called once before writing a (re)attempt's chunks.
- `get_report_export_job_preview_v1(p_job_id, p_page = 1, p_page_size = 50)`
  — `authenticated` only. Same authorization rule as the existing history
  RPC (`daily_report_caller_can_view_v1(job.organization_id, false)`,
  resolved from the job's OWN stored `organization_id`, never a
  client-supplied one). Returns `{ready:false, reason:'not_completed'|
  'no_preview_available', ...}` rather than an error when there's nothing to
  show yet — the frontend hides the section instead of surfacing a scary
  error. `page_size` clamped to [1,200], `page` to >= 1.

Preview is **Detailed Expense only** for this release. Claim
Verification/Approval/Daily Project Report have no stored row set; their
`ServerReportExportPanel` instances simply render no preview section
(`previewSupported = effectiveType === "detailed_expense"`).

### 3c. Report History pagination

`list_report_export_jobs_v2(p_organization_id, p_report_type, p_offset = 0,
p_limit = 5)` — additive; `list_report_export_jobs_v1` is untouched and still
used by anything that wants a plain top-N list. v2 adds a real
`total_count` (a separate `count(*)` in the same query) so the client
renders "Page X of Y" instead of guessing from `rows.length`, plus
`has_preview` per row so a future UI could offer "view this historical
report's preview" without a second round trip to find out (not built in
this release — see Known limitations).

### 3d. Frontend (`ServerReportExportPanel.tsx`)

- Generation complete → Preview Page 1 loads automatically, no extra click.
- A brand-new "Generate" click clears any previous preview and resets
  history to page 1 — a stale preview never appears to belong to a report
  that hasn't finished yet.
- One small shared `Pager` component (Previous / Page X of Y / Next) drives
  both the preview and the history list — proper disabled states, `aria-label`
  on each button, `aria-live` on the page indicator.
- Preview table: `overflow-x-auto` + `sticky` header, so it never breaks
  mobile layout or forces the whole page to scroll horizontally.

---

## 4) Key files

```
supabase/migrations/20260924000000_detailed_expense_report_preview_v1.sql
supabase/migrations/20260930000000_report_export_job_preview_v2.sql
supabase/functions/run-report-export-job/expenseReports.ts
supabase/functions/run-report-export-job/index.ts
src/lib/reportExportJobs.ts
src/components/ServerReportExportPanel.tsx
src/lib/__tests__/detailedExpenseReportPreview.test.ts
src/lib/__tests__/detailedExpenseCanonicalLedger.test.ts
src/lib/__tests__/reportExportWorker.test.ts
src/lib/__tests__/reportExportJobs.test.ts
src/components/__tests__/ServerReportExportPanel.test.tsx
```

---

## 5) Database / migrations

`supabase/migrations/20260924000000_detailed_expense_report_preview_v1.sql`
— additive only (new table, new column, four new/versioned functions; no
existing object altered or dropped). **User runs this SQL manually** against
the target environment; reload PostgREST schema cache afterward.

Proven via a rolled-back transaction against the shared self-hosted
database (migration + a full functional test — chunked writes across a page
boundary with no overlap or gap, exact pagination math, anon rejection
blocked at the GRANT layer, cross-org rejection, not-completed graceful
degrade, history-v2 total_count) — zero permanent footprint. **Not yet
permanently applied** to any environment as of this writing (see §9).

---

## 6) Test plan

- [x] `detailedExpenseReportPreview.test.ts` — new migration's SQL contract
      (grants, RLS, upsert-on-conflict, chunk-boundary math, pagination
      clamping/ordering, authorization source).
- [x] `detailedExpenseCanonicalLedger.test.ts` — format-parity assertions
      (identical headers/column order for all-employees vs. a filtered
      single employee; byte-identical shared rows across both modes).
- [x] `reportExportWorker.test.ts` — updated source-contract guards for the
      renamed `buildDetailedRows`, plus a new guard that the preview is
      stored from the SAME computed objects the CSV is built from.
- [x] `reportExportJobs.test.ts` — new client function source guards
      (`list_report_export_jobs_v2`, `get_report_export_job_preview_v1`,
      default page sizes, graceful-degrade envelope).
- [x] `ServerReportExportPanel.test.tsx` — preview auto-loads on completion;
      Next/Previous fetch the correct page and no others; empty-preview
      message; preview section absent for non-Detailed-Expense types and
      for a not-yet-completed job; history pager appears only with >1 page,
      Next fetches the correct offset, no pager at all on a single page.
- [x] Full suite: 4328/4328 (zero failures). `tsc --noEmit`: 0 errors.
      `npm run build`: succeeds. `migrations:check` / `security:secrets`:
      clean. `eslint` on every touched file: clean (one pre-existing,
      untouched-by-this-change lint finding elsewhere in
      `detailedExpenseCanonicalLedger.test.ts`, unrelated line, not
      introduced here).

---

## 7) Performance / scale

- The browser only ever receives one page (50 rows) at a time — never the
  full report. A 21,000-row report is exactly as light to preview as a
  200-row one.
- `report_export_job_rows` is written in chunks of 500 rows per RPC call
  from the worker (e.g. ~42 calls for 21,000 rows), not one call per row.
- Reading a page is `ORDER BY row_index LIMIT/OFFSET` against a table keyed
  `PRIMARY KEY (job_id, row_index)` — a direct index lookup, not a scan.
- Changing preview page never re-triggers report generation; it is a
  read-only fetch against already-stored data.

---

## 8) Known limitations / follow-ups

- Preview is Detailed Expense only. Claim Verification/Claim Approval/Daily
  Project Report could get the same treatment later, following the exact
  same pattern (store rows at generation time, add a preview RPC) — not
  built here to keep this change scoped.
- `list_report_export_jobs_v2` exposes `has_preview` per history row, but
  the UI does not yet offer "load this historical report's preview" — only
  the just-generated job's preview auto-loads. A natural next step, flagged
  rather than built to avoid scope creep on this release.
- XLSX export remains unimplemented for the worker path (pre-existing,
  documented gap from DOC-106 — `report_export_jobs.format` still accepts
  `'xlsx'` but the worker always produces CSV). Unrelated to and unchanged
  by this work.
- Mobile/accessibility/browser-console QA was done via component tests and
  code review (responsive classes, ARIA labels, disabled-state semantics);
  a live authenticated click-through was not performed this session — see
  the manual QA checklist in the handoff folder.

---

## 9a) Production backend migration record — 2026-09-23

- **Backup**: `pg_dump -Fc`,
  `/home/webadmin/pesowise-safe-backups/20260923T100449Z-pre-detailed-expense-preview-migration.dump`
  (38,943,839 bytes; SHA-256
  `b9cf8eff6455efeb21fa61704910e9da431681606b75a6cef48629c52aecfed5`),
  verified via `pg_restore --list` (2529 TOC entries, 117 `TABLE DATA`).
- **Applied** as `supabase_admin` (the table owner) — `postgres` alone
  cannot `ALTER TABLE public.report_export_jobs`. Migration's own
  `DO $verify$` block passed.
- **Live schema independently re-verified** (not trusted from the
  migration's own success alone): `report_export_job_rows` exists,
  `report_export_jobs.preview_columns` exists, all 4 new/versioned
  functions registered, `list_report_export_jobs_v1` (the one the current
  Production frontend actually calls) still registered and unbroken.
- **PostgREST reloaded** (`NOTIFY pgrst, 'reload schema'`), confirmed via
  the PesoWise-specific container's logs: 79 Relations, 303 Functions
  (+1 table, +4 functions from the pre-migration count).
- **Anon grants — confirmed CLEAN from the start this time**: `anon` has
  zero privileges on the new table and zero `EXECUTE` on any of the 4 new
  functions (`has_table_privilege`/`has_function_privilege` all `false`),
  and a live anonymous HTTP probe against the real public API returns a
  hard `401/42501 permission denied` for the table and all three
  client-facing objects. This migration was written with the explicit
  `REVOKE ... FROM anon` line for every new object from the start (the
  lesson from the earlier `expense_field_memory` incident), so no
  follow-up hardening migration was needed here.
- **Authorization proven live** (rolled-back transaction, zero permanent
  footprint): nonexistent job id rejected, cross-org job id rejected,
  inactive member rejected, cross-org history list rejected — all via the
  live functions themselves, not a simulation.
- **Preview immutability proven live, not just architecturally argued**:
  stored 130 synthetic preview rows, then added ₹999,999 to the
  corresponding employee's LIVE `profiles.balance` mid-transaction, then
  re-fetched the stored preview — the frozen `Opening Balance` value was
  byte-identical before and after the live balance change. This is the
  core design claim (§3b) empirically confirmed against a real
  balance-mutation, not assumed.
- **Pagination proven at a moderate representative scale**: 3,000 rows
  written in 6 chunks of 500 (the worker's real chunk size), last page
  (rows 2951–3000) returned exactly 50 rows, and `EXPLAIN` confirmed a
  **Bitmap Index Scan on `report_export_job_rows_pkey`** — genuinely
  index-backed, not a sequential scan. (3,000 rows rather than a literal
  20,000 to keep the rolled-back transaction lightweight against the
  shared Production database; the query plan does not change qualitatively
  at higher row counts on the same index.)
- **Retry behavior proven**: `clear_report_export_job_preview_v1` followed
  by a fresh `store_report_export_job_preview_chunk_v1` call left exactly
  the new row count, zero duplicates.
- **Failed/not-completed jobs proven to never present as a valid preview**:
  a synthetic `status = 'failed'` job returns `{ready: false, reason:
  'not_completed'}`.
- **Financial integrity unchanged**: `profiles.balance` checksum identical
  before/after (`05b1aed6e4fe3c3c3d80960f85cd3c4e`), `balance_ledger` (370)
  and `expense_balance_deductions` (21,898) row counts unchanged, all 8 real
  MicroLink transactions unchanged, `report_export_job_rows` genuinely
  empty in Production (0 rows) confirming no test data ever leaked in.
- **Expense Field Memory (DOC-130) fully re-verified alongside this
  apply**, live and fresh: employee/org/field isolation, normalization,
  top-25 cap, reuse-without-duplicate, anon/cross-org/inactive-member
  rejection, bootstrap idempotency — all PASS, zero permanent footprint.
  `expense_field_memory` remains disabled for all 7 real organizations,
  including Patidar.
- **Production frontend (still `main`, unaffected) confirmed healthy**
  after the apply: `https://pesowise.unimisk.com` loads, no console errors.
- **MicroLink drift check** since the prior audit snapshot: 21 new
  non-draft expenses created, all 21 independently validated against the
  live canonical validator (`expense_submission_integrity_issues_v1`) —
  zero issues found on any of them.

---

## 9b) Owner QA fix pass — root causes and fixes, 2026-09-23

The owner's first click-through of the Preview deployment found several
issues. Root causes below, in the order investigated, followed by what
changed.

### Root cause: deployed Edge Function was stale

The single root cause behind **missing Employee/Employee ID columns** and
**"preview isn't available"** on a brand-new report: the Production
`run-report-export-job` Edge Function had never been redeployed since
2026-09-05 (files dated 2026-09-05 in `volumes/functions/run-report-export-job/`,
`sha256sum` completely different from the branch source). The deployed
`expenseReports.ts` still had the OLD `singleUserId ? [] : ["Employee",
"Employee ID"]` conditional (the exact DOC-131 bug this branch already
fixed in source), and the deployed `index.ts` had no
`storeDetailedExpensePreview` call at all — so it was structurally
impossible for that deployed code to ever store a preview or include
identity columns for a single employee, regardless of what the branch
source said. **Not assumed — proven** via `sha256sum` on both the deployed
files and the branch source before touching anything.

Fixed by deploying the current branch's `run-report-export-job/{index.ts,
expenseReports.ts}` to the Production functions volume (backed up the
previous deployed files first with a timestamp suffix) and restarting the
`supabase-edge-functions-evo3o0fdjaroxq7uohrm21cp` container. Verified via
byte-identical `sha256sum` against the branch source post-deploy, a clean
container restart (`Up ... (healthy)`, `main function started` in logs with
no crash loop), and the full worker test suite passing against this exact
source. A live HTTP smoke test through the deployed function was not
performed — it would require extracting a service-role or user credential,
which this session's own safety classifier correctly refuses; the next real
report generation (including the owner's own click-test) will exercise this
code.

### Root cause: recent-value dropdown render path depended on data arrival, not on the feature flag

`BaseExpenseFieldInput.tsx` only rendered `RecentValueTextInput` when
`recentValues && recentValues.length > 0` — so "feature enabled, no history
seeded yet" and "feature disabled" were indistinguishable code paths, both
silently falling back to a plain input. This is a real code-path
determinism gap (fixed: a new explicit `memoryEnabled` prop now decides the
render path on its own, independent of whether data has arrived), but it
was **not, by itself, why the owner saw nothing** for Vendor/Location: a
live, rolled-back-transaction diagnostic (seed data → RPC → same result the
UI would receive) proved the RPC/data pipeline itself was already correct.
The dropdown was empty because the organization used for testing had no
`expense_field_memory` history yet, not because of a bug in the fetch path.

Also fixed, found while auditing the same pipeline: `ExpenseBatchForm.tsx`
never called `useRecentExpenseFieldValues` at all for its
destination/purpose fields (it recorded values after save, but never
fetched them back) — batch entry's memory suggestions were completely
unwired, a separate gap from the single Expense Form's gating bug. And
`useRecentExpenseFieldValues`'s effect had no way to know a save had
invalidated the cache unless the whole component remounted — a version
counter in `expenseFieldMemory.ts`, bumped on every successful
`recordRecentExpenseFieldValues`, is now in the hook's dependency list so a
save refetches on the next render even without a route change.

**A real, permanent seed of `expense_field_memory` (enabling the flag +
inserting realistic recent-value rows) for the designated synthetic QA
organization (`QA Synthetic Org - DOC128`) was attempted and blocked twice
by this session's own safety classifier** (`Modify Shared Resources`,
`Feature Flag Writes` — a standing configuration change, correctly gated).
The mechanism itself was proven correct via a rolled-back transaction
instead (zero permanent footprint). Enabling the flag and seeding a few
realistic values for that org is the one remaining manual step before the
owner can see a populated dropdown — see the final report for exact
values to insert, or the owner can simply toggle the feature on for that
org and submit two or three real test expenses themselves.

### Root cause: filename used today's date, never the report's own range

`index.ts` built every filename as `${type}_${today}.csv`. For Detailed
Expense specifically, this is now `buildDetailedExpenseFilename()`:
employee name/code (server-resolved from the already-fetched timeline rows,
falling back to a direct `profiles` lookup only when that employee has zero
rows in the requested range) or `All-Employees`, plus the actual requested
date range (`DD-MM-YYYY_to_DD-MM-YYYY`, or `all-time`) — never the
generation date. Sanitized against path traversal and unsafe filesystem
characters; Unicode names are preserved.

### Root cause: Week was fully wired to nothing

`selectedWeek` existed in component state and in a (permanently disabled)
React Query key, but was never passed into the server report request at
all — an audit confirmed no code path read it. There was no prior working
Week implementation to preserve, so ISO-8601 week-of-year (Monday–Sunday)
was chosen as the one, deterministic new semantic
(`src/lib/detailedExpenseReportFilters.ts`), with boundary tests for a
year's first/last week and a week crossing a month boundary. Week now takes
precedence over Month over a bare Year in the one canonical date-range
derivation used for the server request, the filename, and the history
summary.

### Root cause: Expense Type and custom-field filters never reached the Detailed Expense worker

`category` reached `report_export_jobs.parameters` but
`buildDetailedExpenseReport` never read it; custom-field filters never left
the browser at all. Both are additive keys in the same `parameters` jsonb
(`create_expense_report_export_job_v1`'s `p_filters` was always schemaless,
so no migration was needed for this half). The worker now applies both as a
**presentation-only post-filter** over the already-fetched, already-balanced
full timeline (`matchesDetailedExpenseFilters`) — never by asking
`report_balance_timeline_rows_v3` for a partial event set, which would
recompute Opening/Closing Balance as if the hidden events never happened.
Only `event_type = 'expense_deduction'` rows are ever excluded by these
filters; balance credits/additions remain visible regardless, mirroring the
pre-existing client behavior where the category filter only ever narrowed
the expenses query, never the separate credit/transfer history.

### Root cause: Report History never showed what a job was actually generated with

`report_export_jobs.parameters` was already a frozen, per-job snapshot from
enqueue time — it was just never returned to the client. New, additive
`list_report_export_jobs_v3` (v1/v2 untouched) returns it verbatim plus a
server-resolved `employee_display` (name + employee code, never a raw
UUID). The frontend renders it as a compact per-row summary (employee line,
date range, then a single truncated "Expense Type: X · Week: Y · Field:
value" line, only for parameters actually recorded on THAT job — omitting
Week/custom-field chips entirely for older jobs that never recorded them,
rather than fabricating "Week: All"). Reading directly from each job's own
stored `parameters` (never from the caller's current filter controls) is
what guarantees a history row can never change when today's filters change.

### What did NOT change

`report_balance_timeline_rows_v3`'s own balance computation, the frozen
preview-row storage design (§3b), `list_report_export_jobs_v1`/`v2`, the
Production frontend (still `main`), and Expense Field Memory's enablement
state for every real organization (still 0 of 7, including Patidar) — none
of this fix pass touched any of them.

---

## 9c) Detailed Expense V4 — full expense coverage, 2026-09-23

A second owner click-test found the on-page/filename/preview fixes above
working, but the report itself still fundamentally incomplete: an "All
Employees, 2026" Patidar report showed ~734 rows against thousands of real
approved expenses.

**Root cause, confirmed by direct count, not assumed**:
`report_balance_timeline_rows_v3`'s expense-shaped events come exclusively
from `expense_balance_deductions` — the modern balance-ledger deduction
path. For Patidar, only 650 of 2,924 valid approved expenses have ever had
a deduction row written (the other 2,274 are legacy approvals that predate
that mechanism). 650 `expense_deduction` rows + 83 `cash_transfer_in` + 1
`opening_credit` = the observed 734. The report was never wrong about
pagination or filtering — it was reading the wrong population.

**Fix — `report_detailed_expense_rows_v4`** (new function, `_balance_timeline_events_v3`
and `report_balance_timeline_rows_v3` both untouched, still shared with the
live Balance Ledger feature): every APPROVED, valid-profile expense in
`expenses` is a row, dated by `trip_start`, whether or not it has a modern
deduction record. Non-expense events are reused unchanged from
`_balance_timeline_events_v3`.

**The one judgment call, made explicit rather than hidden**: Patidar's
`balance_ledger` has no historical-anchor/reconciliation rows at all — only
83 cash transfers and 1 opening credit. That means the per-employee
"carried-in balance" (reconstructed as `profiles.balance − Σ existing ledger
deltas`) was never proven to already exclude the 2,274 legacy expenses' own
effect, and this migration cannot determine from data alone whether it does.
Adding a new negative delta for each one now would risk double-counting
against a balance that may already reflect it. The migration therefore takes
the only choice that cannot corrupt an already-trusted number: a legacy
expense is a full, real report row (title/category/purpose/destination/
custom fields/transaction number, real amount shown in Debit) but its
balance-affecting delta is exactly 0 — Opening equals Closing for that row.
Every row is tagged `modern_deduction_present` so this is auditable. If the
owner independently confirms the legacy expenses' effect is already baked
into the current balance, no further action is needed; if not, that is a
genuine historical accounting question outside a report's scope to resolve
unilaterally.

**Proof, against real Patidar Production data, rolled back after**:

| Check | Result |
|---|---|
| 2026, valid approved expenses (direct count) | 2,836 |
| V4 expense rows, 2026 | 2,836 |
| Missing approved expense IDs, 2026 | 0 |
| Missing approved expense IDs, all-time | 0 |
| Extra V4 IDs not in the direct source, all-time | 0 |
| Duplicate expense IDs in V4 output | 0 |
| Modern rows (650) vs V3's own Opening/Closing/Debit, all 650 compared | 0 mismatches — byte-identical |
| Legacy rows with any balance movement | 0 |
| Legacy rows with a null/blank Debit | 0 |
| Carried-in opening balance across the 2026 window boundary (one real employee) | Matches exactly |

**Applied to Production** the same day: fresh backup
(`20260923T125255Z-pre-detailed-expense-v4-migrations.dump`, verified via
`pg_restore --list`), migration's own verify block passed, live schema/anon
grants re-confirmed (`anon`/`authenticated` both correctly denied — worker/
service_role only), PostgREST reload confirmed (+1 function), live anon HTTP
probe returns `401`, financial integrity unchanged (`profiles.balance`
checksum, `balance_ledger` (370) and `expense_balance_deductions` (21,898)
row counts all identical before/after). Worker redeployed to match, verified
via byte-identical `sha256sum` and a clean container restart.

Only the Detailed Expense worker path switches to V4 — Claim Verification,
Claim Approval and Daily Project Report are untouched.

---

## 9c-2) Final accounting-consistency fix — legacy expenses now really debit, 2026-09-23

§9c's first V4 pass made legacy expenses full report rows but gave them a
**zero** balance-affecting delta, out of caution about double-counting. A
completed, independent 31-gate forensic audit of Patidar
(2026-09-20 — see `patidar-historical-truth-audit` project memory and the
audit's own report) proved this caution was unwarranted: its Model C ("old
software actual behavior") reproduces all 16 employees' current balances
and 2,599/2,599 independent historical observations exactly — the legacy
expenses genuinely debited balances under the old software, every one of
them. A zero-delta row was financially wrong.

**The corrected model** (`20260929000000_detailed_expense_v4_balance_reconciliation.sql`,
`CREATE OR REPLACE` of the same function, same signature):

1. Every expense — legacy or modern — now has a real delta, `-total_amount`.
   Debit always equals the expense's own amount; Opening/Closing move by
   exactly that amount for every expense row, no exceptions.
2. The "carried-in balance before an employee's earliest known event" —
   previously hidden arithmetic (a `baseline_before` term folded silently
   into the running sum) — is now an explicit, visible, **report-only**
   `historical_opening_balance` row per employee, computed as
   `current_balance − Σ(every other known signed event)`. This is never
   written to `balance_ledger`/`profiles.balance`/any accounting table; it
   is purely this function's own output. It guarantees the row-arithmetic
   invariant (Opening + Credit − Debit = Closing) holds for every row
   including itself, and guarantees the final Closing Balance always
   reconciles to the real current balance — the same guarantee the old
   hidden term already made, now honest and auditable instead of invisible.
3. A new, generic, report-only table — `report_historical_reconciliation_events`
   — lets a small number of independently-proven historical facts become
   their own explicit, separately-labeled rows instead of being silently
   absorbed into the residual. Seeded with the audit's 3 **proven** duplicate
   deductions (Dipa txn 01090 ₹487, Pravin txn 01162 ₹2,000, Mahendrasinh
   txn 01267 ₹3,738 — the old software's read-then-write approval race
   deducted each twice, though only one expense record exists for each).
   This is **data**, not SQL logic — the function body contains zero
   Patidar-specific or employee-specific conditionals; any other
   organization's table stays empty until a fact is independently proven
   for it the same way.
4. **Deliberately not attempted**: precisely modeling the March 2026
   zero-balance discontinuity as a mid-timeline event. The audit proves the
   *effect* (every employee holding a balance was at exactly ₹0.00 in a
   specific 6-hour window on 2026-03-02) but not which statement, run by
   whom, produced it — and reconstructing it precisely would require
   replaying events in actual processing (approval) order, which conflicts
   with the owner's own non-negotiable business-date rule (`trip_start`
   governs display and ordering for this report). The single opening-balance
   residual honestly absorbs this specific uncertainty instead: every
   expense still shows its real debit, every row's arithmetic still holds,
   and the final balance still reconciles exactly, but the report does not
   claim to show the precise historical shape of the March discontinuity.
   **Wording note**: nowhere does this migration or its documentation claim
   the org-wide reset script (`reset_balances_org_496fb7f7.sql`, found but
   never proven executed) actually ran — only that its *effect* is proven.

**Proof, against real Patidar Production data, rolled back after**: 0
missing/extra/duplicate expense IDs (unchanged from §9c); 0 row-arithmetic
failures across all 3,024 rows; 0 rows with Debit > 0 and Opening ==
Closing (the specific defect this fix closes); all 14 employees with
activity reconcile to their current `profiles.balance` to the cent (sum-of-
deltas check); 20/20 legacy sample and 20/20 modern sample proofs; the 3
seeded duplicate-deduction rows render with their proven amounts.

Applied to Production the same day: fresh backup
(`20260923T132151Z-pre-detailed-expense-v4-balance-reconciliation.dump`),
live schema/grants re-confirmed (new table + function both correctly denied
to `anon`/`authenticated`), PostgREST reload confirmed, live anon HTTP probe
returns `401`, financial integrity unchanged (Patidar's own 650 modern
deductions and 2,927 approved expenses both exactly unchanged; the
organization-wide `expense_balance_deductions` count grew by ordinary,
unrelated live MicroLink activity, confirmed by org-level breakdown, not by
anything in this migration).

---

## 9d) Expense Field Memory — actually working, 2026-09-23

The same click-test found the recent-value dropdown never appeared at all,
and the owner's own network capture confirmed `get_recent_expense_field_values_v1`
was never called — not "zero matches", the fetch never ran.

**Root cause**: `AuthContext.tsx` hydrated `organizationFeatureFlags` from a
localStorage snapshot and only refreshed it from the database once that
snapshot was more than 5 minutes old. Toggling `expense_field_memory` and
testing immediately — well inside that window — left the client believing
the feature was still off, so `useRecentExpenseFieldValues`'s own `enabled`
input was `false` and it never reached the RPC at all. This is documented in
full, with its own proof, in `expense-field-memory.md` §(memory fix) — the
short version: a new, independent `refreshOrganizationFeatureFlags` now runs
on every fast-path hydration regardless of cache age, plus a Realtime
subscription on `organization_features` (now added to the
`supabase_realtime` publication) propagates a same-tab toggle immediately.
A new self-bootstrap RPC, `bootstrap_my_expense_field_memory_v1`, seeds an
enabled employee's own memory from their own approved history the first
time they read it, so an enabled feature with real history does not stay
empty until a brand-new expense happens to be saved.

---

## 9e) Excel-style preview sort/filter + Report History "View", 2026-09-23

Final owner QA pass on top of §9c-2, covering three remaining UX gaps
after core functionality (memory dropdown, ~2,930-row Patidar coverage,
preview, 5/page history) was confirmed working.

**Memory provenance audit (separate feature, documented in
`expense-field-memory.md` §8c)**: confirmed zero cross-employee leakage for
`employee@mistryandshah.com` — all 57 memory rows shown belonged to that
one employee alone, via live RPC source inspection plus a genuine
two-employee rolled-back isolation test.

**Excel-style server-side sort/filter (`get_report_export_job_preview_v2`,
new migration `20260930000000_report_export_job_preview_v2.sql`)**: adds
`p_sort_column` / `p_sort_direction` / `p_column_filters` to a NEW versioned
RPC — `get_report_export_job_preview_v1` is completely untouched. Sorts and
filters the ENTIRE frozen `report_export_job_rows` set for the job (never
just the rendered page), then paginates — the response carries both
`total_count` (the report's real row count) and `filtered_total_count`
(after view filters). Column kind (date / money / text) is classified
generically from the report's own fixed column names (`Date`,
`Credit`/`Debit`/`Opening Balance`/`Closing Balance`); every other column,
including every dynamic custom-field column, is plain text — nothing is
keyed on an organization id or a specific field name. Money values sort
numerically via `NULLIF(regexp_replace(value, '[^0-9.\-]', '', 'g'), '')::numeric`
(proven: `₹9,000.00` sorts before `₹10,000.00`, and a negative
`-₹1,167.30` sorts correctly signed) while the displayed string is never
altered; dates sort via `to_date(value, 'DD-MM-YYYY')`, never JS `Date`
parsing. No dynamic SQL: sort/filter columns are validated against the
job's own frozen `preview_columns` before use, and ordering uses six
parallel `CASE WHEN <kind> AND <direction> THEN ... END ASC|DESC` branches
(exactly one non-NULL per row for any given combination) rather than
`EXECUTE`. Same authorization as v1
(`daily_report_caller_can_view_v1`, anon blocked at the GRANT layer).

A real bug was caught and fixed before this shipped: the function's final
`jsonb_agg(...)` re-sorted its result by `row_index` regardless of the
requested sort, so every sort request still selected the mathematically
correct page of rows but silently rendered them back in canonical order.
Fixed by repeating the same six-branch ordering inside the aggregation's
own `ORDER BY`. Caught by a rolled-back-transaction test against synthetic
rows built specifically to expose it (tied Employee names, a `₹9,000` /
`₹10,000` pair, and a negative Debit) — every sort/filter/pagination/
authorization case in the migration's design was proven this way,
including sort-then-paginate ordering (page 1/size 2 of Debit-ascending
returned the two lowest values, not the two lowest by row_index).

Frontend (`ServerReportExportPanel.tsx`): a new `ColumnHeaderMenu`
component (Popover-based, reusing existing PesoWise UI primitives) gives
each header a sort asc/desc control plus a kind-appropriate filter
(contains / from-to / min-max), a "Clear this filter" action, and a
"Reset view" control that restores canonical order/no filters/page 1. The
"Showing" line becomes "Showing 1–50 of 124 matching rows / 2,930 rows in
generated report" once a filter is active. Sorting never recalculates
Opening/Closing Balance — a small note says so when a sort is active.
Transaction # / Employee ID are never classified as money (verified by
test), so they keep their leading zeros and sort as plain text.

**Report History "View"**: a new `activePreviewJobId` state, distinct from
"the most recently generated job" — clicking "View" on any history row
loads THAT job's own frozen preview (page 1, sort/filter reset) and its own
header metadata (filename, generated timestamp, frozen parameters) into the
Generated Report area, without disturbing the live generation/Download
button tied to the current polling job. A sticky `activePreviewEntry`
(distinct from a live `history.find(...)` lookup) keeps the viewed job's
own metadata and Download target correct even after the user pages history
away from that row — the preview and Download target are proven, by test,
to survive history repagination rather than silently reverting. Exactly one
history row shows a "Viewing" badge at a time. A job predating stored
previews shows the existing "Preview wasn't stored…" message (worded to
say "Download the file to view it" when reached via View, versus "Generate
a new report to preview it here" for the auto-preview-after-generation
case) — Download stays available either way.

New migration applied to Production (fresh backup
`20260923T141203Z-pre-report-export-preview-v2.dump`, SHA-256
`65fbec02798691205614c902076a7193f91ad85f235ff5894af294021064eeba`, verified
via `pg_restore --list`, 2571 TOC entries). Live grants re-verified (`anon`
= false, `authenticated` = true, `public` = false); `get_report_export_job_preview_v1`
confirmed byte-identical (`pg_get_functiondef` hash unchanged). PostgREST
schema reload confirmed via container logs (Functions: 306 → 307). Anonymous
HTTP probe against the new RPC returned 401. **Worker (`run-report-export-job`)
was NOT redeployed — its own code did not change this pass; v2 is a
pure client-facing read RPC, unrelated to report generation.** Financial
integrity unchanged: the migration contains no DML on any table (verified by
grep), and `expenses`/`expense_balance_deductions`/`balance_ledger`/
`report_historical_reconciliation_events` row counts are unaffected. New
cache-identity-isolation regression tests added to
`expenseFieldMemory.test.ts` (cross-user same-org, cross-org same-user,
same-identity cache hit). Full suite 4467/4467, tsc/build/migrations:check/
security:secrets/eslint all clean. Not merged to `main`.

---

## 9f) MicroLink report failure — header-only files, a 60 s platform limit, and job visibility, 2026-09-24

Owner report: for MicroLink Administration "reports do not generate / history
does not show them". Diagnosed stage by stage (browser → DB → worker →
storage → history → preview) against Production before writing any code.

**What was NOT the problem** (all verified in Production): organization
context (23,665 MicroLink expenses, 21,649 approved, 0 approved without a
profile), membership/permissions (client and server agree; 0 users with more
than one active membership anywhere), enqueue (a job row existed for every
attempt), the queue (0 queued/running/stale; a host cron drainer runs every
2 minutes), stale recovery (works, proven live and in a rolled-back test), and
row sources (counts match exactly).

**Root cause 1 — every Detailed Expense CSV since the 2026-09-23 worker deploy
was header-only garbage** (MicroLink and Patidar alike; introduced by this
branch, never on `main`). `run-report-export-job/index.ts` imported the shared
`toCsv(headers, rows)` and also declared a module-local `toCsv(rows)` for the
Daily Project report; the local function shadowed the import, so the file was
the Daily Project header line plus blank rows (15 headers → 628 bytes, 20 →
748 bytes: reproduced to the byte, and equal to Production's stored sizes).
Row counts and the on-page preview were correct, so jobs looked "completed".
Fix: the Daily builder is now `toDailyProjectCsv`; a new
`assertCsvMatchesRows` guard (header must equal the report's own header, at
least one physical line per row) runs between building and uploading, so this
class of bug now fails the job loudly instead of shipping an unusable file.

**Root cause 2 — the worker's 110 s soft deadline exceeded the platform's
60 s hard limit** (`workerTimeoutMs` in the functions service `main/index.ts`).
A report needing more than 60 s was cancelled by the supervisor with no
failure recorded: `running` until the 5-minute stale sweep, requeued, killed
again, until attempts ran out (observed live: 12:52 over 3 attempts for a
MicroLink Daily Project week). Fix: soft deadline 50 s; a report that cannot
finish fails at once with "This report is too large to build in one pass.
Narrow the date range or filters and try again." and is **not** retried;
Detailed Expense paging 250 → 500 rows/page (the V4 function clamps at 500; each
page recomputes the ordered timeline) cut MicroLink 2026 from 56 s / 88 pages
to 25 s / 44 pages with identical output. **Not fixed:** Daily Project ranges
that cannot finish in one 50 s pass (MicroLink 7-day range: 8,270 groups) —
measured, now fails cleanly and visibly, and needs resumable/chunked
generation as follow-up work.

**Queue targeting.** The browser's nudge sent an empty body, so the worker
claimed the globally oldest queued job — possibly another organization's. New
`claim_report_export_job_v2(worker, job_id, cap)` (service_role only, row lock +
SKIP LOCKED, cancellation and per-org cap honoured) claims exactly the job the
user just created; `triggerExportWorker(jobId)` sends `{job_id}`; no `job_id`
keeps the global oldest-first claim for the cron backstop. Proven in a
rolled-back transaction (targeted claim leaves an older other-org job
untouched; cap blocks; a healthy running job is not stolen; a stale one is
recovered and unblocks the next) and live.

**Job visibility.** `list_report_export_jobs_v4` lists queued / running /
completed / failed / cancelled jobs (5 per page); only failed jobs expose their
already-sanitised reason. The panel now restores the latest job in ANY state on
reload (queued/running resume polling, failed shows its reason and Retry),
shows status badges, progress and safe errors per history row, offers Retry
(re-enqueues with that job's own frozen parameters as a new job), states
"Completed with 0 rows — no rows matched these filters" for genuinely empty
reports, explains that claim/daily reports have no preview (success = row
count + Download), logs previously swallowed history/preview/poll errors, and
resets all report state when the organization or report type changes.

**Multi-membership.** `AuthContext` resolved role and organization with
`.maybeSingle()` over all active memberships, which fails for a user with two.
It now selects the membership for the profile's current organization
(`pickCurrentMembership`, unit-tested). Latent: no such user exists in
Production today. The server-side permission function was already scoped by
organization.

**Live proof (MicroLink, real enqueue RPC as the MicroLink admin):** Claim
Approval 21,649 rows = direct source 21,649 (9 s, 7.4 MB); Detailed Expense
2026 21,828 rows (21,649 expense + 179 other; missing 0, extra 0, duplicates 0)
in 25 s, 5.8 MB, preview rows 21,828. Migration
`20261001000000_report_export_queue_v2.sql` applied to Production (backup
`20260924T173440Z-pre-report-queue-v2.dump`, SHA-256
`608abe6f7ba9ba4a4063aa193f5484ff340ca0e04a9d7e09eec0d9cfd4d494fd`, 2574 TOC
entries); worker redeployed to the PesoWise stack only (hashes match the
branch). Zero financial DML; balances/ledger/deductions checksums unchanged.

---

## 9g) Final integrated QA polish — preview sort, request ordering, UI separation, 2026-09-25

**Sort investigation (proved stage by stage).** Live `get_report_export_job_preview_v2`
was identical to the repository migration (definition hash match) and, called directly
on a real 21,828-row frozen MicroLink report, sorted the WHOLE report correctly (Date
chronologically, Debit numerically, Employee alphabetically, about 100 ms). So the
backend was not the reason a sort looked like it did nothing. Findings:

1. **Backend defect (real):** blanks floated to the top in some directions (NULL sorts
   first for DESC, an empty string first for text ASC), so Debit Desc and Transaction #
   Asc opened on a page of empty cells (179 balance-only rows).
2. **Client, feedback:** the menu stayed open after Asc/Desc and the table gave no
   loading cue, so a click looked ambiguous; a report already in canonical order
   (single employee, Date Asc) legitimately looks unchanged.
3. **Client, ordering hazard:** preview loads were guarded only by organization/report,
   not by "newest request wins", so a slower earlier response (page change, old filter,
   auto-preview after generation) could overwrite a newer sort; `applyFilter` also
   started its network request inside a React state updater.

**Fixes.** New additive `get_report_export_job_preview_v3`
(`20261002000000_report_export_job_preview_v3.sql`; v1/v2 untouched): blanks last for
both directions and every column kind, case-insensitive text, all-digit values
(Transaction #, Project ID) ordered numerically while the displayed value keeps its
leading zeros, parse-safe date/money/filter handling, one `row_number()` rank driving
both paging and the returned array, `row_index` as the final tie-break. The client
routes every preview load through the existing generation-token guard (`monthFetchGuard`,
the same primitive as the My Expenses month fetch) and invalidates it on every reset;
Asc/Desc now closes the menu, resets to page 1 and shows an "Updating preview…" overlay
over the retained table.

**Proof.** Rolled-back run of v3 on the real 21,828-row report: Date, Debit, Employee and
Transaction # asc+desc correct with blanks last (the last page of Txn Asc holds the 28
blanks); walking every page of Date Desc returned 21,828 rows / 21,828 distinct positions
(whole-report sort); Employee + Expense Type combined filter narrowed 102 to 94;
date-range, Debit min/max and a dynamic-field (Project ID) filter all correct; bad column
rejected (`22023`), anon blocked. A real browser session against the actual panel (data
source mocked) confirmed Date, Desc sends `p_sort_column=Date`, `p_sort_direction=desc`,
the menu closes, and the rendered rows are in the returned descending order.

**UI polish (semantic tokens only; light, dark and 375 px verified in a browser).** Vertical
and horizontal cell borders, distinct sticky header, subtle zebra and hover rows; the
sort/filter menu is an opaque bordered, shadowed popover with stacked From/To dates, an
accent-styled trigger showing an arrow and a filled funnel plus dot when a filter is
active, and clear Asc/Desc/Apply/Clear buttons; Generated report and Report history are
separate bordered sections; the Viewing history row has an accent left bar and tint. The
menu stays inside the viewport near the right edge (portal, not clipped by the table)
and fits at 375 px with no page overflow.

**Month + Year filter (DOC-127): verified, not re-merged.**
`hotfix/close-singular-expense-review-dialog` (tip `f631fed`) is already an ancestor of
this branch (0 unique commits), all intended files are present, and
`get_my_expenses_page_v1` (with its canonical custom-field helper) was already live in
Production with authenticated-only grants, so its migration was not re-applied. See
`expense-month-year-filter.md`.

Migration applied to Production after a verified backup
(`/home/webadmin/pesowise-safe-backups/20260925T070449Z-pre-preview-v3.dump`, SHA-256
`5030c24f348544cd6f64568b05d30ae47855b57e40e442c8a7548d1b9518ab9e`, 2580 TOC entries);
PostgREST reloaded, anonymous probe 401. Zero financial DML. The Daily Project
single-run limit is unchanged (still fails cleanly for very large ranges).

---

## 9) Rollback


Purely additive: the new table/column/RPCs can be ignored by simply not
calling them. If ever needed, `DROP FUNCTION` the four new/versioned
functions and `DROP TABLE report_export_job_rows` / drop the
`preview_columns` column — this only removes the preview/pagination
convenience, never touches `report_export_jobs` itself, generated files in
Storage, or any accounting data. `get_report_export_job_preview_v2` can
independently be `DROP FUNCTION`-ed at any time without affecting v1.

---

## 10) Related docs

- [DOC-106 — Server-side report generation](./server-side-report-generation.md)
  (the job queue, worker, and CSV pipeline this builds on)
- [DOC-116 — Detailed Expense canonical balance](./detailed-expense-canonical-balance.md)
  (why Opening/Closing Balance is computed the way it is, and why that rules
  out a live re-query for the preview)
- [DOC-132 — MicroLink custom-field integrity re-audit](./microlink-custom-field-integrity-reaudit-2026-09.md)
  (companion read-only audit performed alongside this release, at the
  owner's request, on the same branch)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-09-23 | 1.0 | Agent | Initial implementation on `feature/recent-expense-field-values` (reused per explicit instruction, for one integrated Preview deployment alongside Expense Field Memory). Format parity, on-page preview, and history pagination all implemented and tested; migration proven via a rolled-back transaction, not yet permanently applied to any environment. |
| 2026-09-23 | 1.1 | Agent | **Backend migration applied to Production** (same day, later session), per explicit owner authorization scoped to this additive backend change only. Fresh backup taken first. Live schema/grants/authorization/immutability/retry/failure-handling all independently re-verified against the live database (immutability specifically proven via a real live-balance mutation, not just argued). Anon confirmed with zero access from the start — no hardening follow-up needed this time. Production frontend (still on `main`) confirmed unaffected and healthy. Expense Field Memory re-verified alongside. Frontend/UI for this feature remains unmerged and undeployed — see the header banner. |
| 2026-09-23 | 1.2 | Agent | **Owner QA fix pass** (same day, later session). Root-caused and fixed: a stale Production Edge Function deployment (redeployed + verified), a data-arrival-gated memory render path (now an explicit `memoryEnabled` prop), an unwired batch-form memory fetch, a dead Week filter (new ISO-week canonical date-range model), Expense Type/custom-field filters never reaching the Detailed Expense worker (now a presentation-only post-filter that never touches balance computation), a filename using today's date instead of the report's range, and Report History with no parameter summary (new additive `list_report_export_jobs_v3`). See §9b. Full test suite (4388/4388), `tsc`, build, `migrations:check`, `security:secrets` all clean. One item remains blocked by this session's own safety classifier: permanently enabling + seeding `expense_field_memory` for the synthetic QA org, proven correct instead via a rolled-back transaction. |
| 2026-09-23 | 1.3 | Agent | **Critical integrated fix pass, same day, later session.** Root-caused and fixed the two most serious remaining owner-observed issues. (1) **Detailed Expense was still fundamentally incomplete**: confirmed the report's expense-shaped events came exclusively from `expense_balance_deductions` (only 650 of 2,924 valid approved Patidar expenses ever got one) — new `report_detailed_expense_rows_v4` sources every APPROVED expense directly from `expenses`, proven against real Patidar data with 0 missing/duplicate expense IDs (2026 and all-time) and byte-identical Opening/Closing/Debit for all 650 modern rows versus V3. See §9c for the full record, including the explicit legacy-balance judgment call. (2) **The memory RPC never fired at all** (confirmed via the owner's own network capture): root-caused to `AuthContext.tsx`'s 5-minute-cached feature-flag hydration — fixed with an independent, unconditional refresh plus a Realtime subscription on `organization_features`, and added a new self-bootstrap RPC so an enabled employee's own approved history seeds their memory automatically. See §9d. 3 new migrations applied to Production (fresh backup, live grants/anon probes re-verified, financial integrity unchanged); worker redeployed and restarted, verified via matching `sha256sum`. Full suite 4438/4438, tsc/build/migrations:check/security:secrets/eslint all clean. Not merged to `main`. |
| 2026-09-23 | 1.4 | Agent | **Final accounting-consistency fix, same day, later session — see §9c-2.** §9c's zero-balance-delta for legacy expenses was financially wrong: a completed, independent 31-gate forensic audit (2026-09-20) proves the old software genuinely debited every legacy expense (Model C reproduces all 16 employees' balances and 2,599/2,599 historical observations exactly). Replaced with a corrected model: every expense (legacy or modern) has a real delta; the carried-in balance before an employee's earliest event is now an explicit, visible, report-only `historical_opening_balance` row (never written to any accounting table) instead of hidden arithmetic; a new generic `report_historical_reconciliation_events` table lets independently-proven facts (seeded here with the audit's 3 proven duplicate deductions) become their own labeled rows. Deliberately did not attempt precise mid-timeline placement of the March 2026 zero-balance discontinuity — the effect is proven but the exact mechanism is not, and precise placement would require approval-order replay that conflicts with the owner's own trip_start business-date rule; documented as an explicit, honest trade-off rather than fabricated precision. Proven against real Patidar data: 0 row-arithmetic failures across 3,024 rows, 0 rows with Debit>0 and no balance movement, all 14 active employees reconcile to the cent, 20/20 legacy and 20/20 modern sample proofs. New migration applied to Production (fresh backup, live grants re-verified); no worker code changed this pass. Full suite 4456/4456, tsc/build/migrations:check/security:secrets/eslint all clean. Not merged to `main`. |
| 2026-09-25 | 1.7 | Agent | **Final integrated QA polish, see §9g.** Preview sort investigated end to end: backend v2 proven correct on a real 21,828-row report, but blanks sorted first for some directions, so a new additive `get_report_export_job_preview_v3` (blanks last, case-insensitive text, digits ordered numerically with display unchanged, parse-safe, single rank for paging and output). Client: newest-request-wins guard on every preview load, menu closes on Asc/Desc, loading overlay, `applyFilter` no longer fires a request inside a state updater. UI: grid borders, header hierarchy, zebra/hover rows, opaque popover with stacked date inputs and clear sort/filter indicators, separated Generated report and Report history sections, stronger Viewing row; verified light, dark and mobile in a browser. DOC-127 month filter verified (already an ancestor; RPC already live). Migration applied with a verified backup. Not merged to `main`. |
| 2026-09-24 | 1.6 | Agent | **MicroLink report failure — see §9f.** Root-caused to a worker bug introduced by this branch (a local `toCsv` shadowing the shared import made every Detailed Expense CSV header-only since 2026-09-23) plus a 110 s soft deadline against the platform's real 60 s limit (silent kill, stale-recovery loop). Fixed both (renamed builder + integrity guard; 50 s non-retryable deadline; 500-row V4 paging: MicroLink 2026 56 s → 25 s), added targeted job claim (`claim_report_export_job_v2`), all-status history (`list_report_export_jobs_v4`), reload-safe failed/queued/running restoration, Retry, org-switch state reset, and multi-membership-safe role resolution. Migration applied to Production with backup; worker redeployed (PesoWise stack only). Live MicroLink proof: Claim Approval 21,649/21,649, Detailed 2026 21,828 rows with 0 missing/extra/duplicate. Daily Project ranges beyond one 50 s pass now fail cleanly; resumable generation is documented follow-up. Not merged to `main`. |
| 2026-09-23 | 1.5 | Agent | **Final preview UX + memory provenance pass, same day, later session — see §9e.** Added Excel-style server-side sort/filter over the entire frozen report via a new `get_report_export_job_preview_v2` RPC (v1 untouched) — numeric money sort, chronological date sort, contains/range/min-max filters, all injection-safe (no dynamic SQL, columns validated against the job's own frozen `preview_columns`). A real bug (final `jsonb_agg` silently discarding the requested sort order) was caught by a rolled-back-transaction test and fixed before shipping. Added a Report History "View" control (`activePreviewJobId` + a sticky `activePreviewEntry`) that loads any older job's own frozen preview and metadata without disturbing the live generation, survives history repagination, and correctly retargets Download. Memory provenance audit (separate feature) found zero cross-employee leakage — see `expense-field-memory.md` §8c. New migration applied to Production (fresh backup, live grants/schema-reload/anon-401 all re-verified); worker deploy not required (v2 is read-only, unrelated to generation). Financial integrity unchanged (DDL-only migration, verified by grep + row counts). Full suite 4467/4467, tsc/build/migrations:check/security:secrets/eslint all clean. Not merged to `main`. |
