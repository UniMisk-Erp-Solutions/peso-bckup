# Daily Project Report — Server-Side Scalability at 9,000+ Expenses

**Doc ID:** DOC-101
**Status:** in progress — implemented on branch, migration NOT applied to Production
**Last updated:** 2026-08-20
**Owner / area:** Reports → Daily Project Report, Supabase

---

## 1) Summary

The Daily Project Report was silently producing incomplete workbooks. It pulled the
organization's entire approved-expense set into the browser in one unbounded PostgREST
request — which PostgREST capped at 1,000 rows without any error — then enriched those
expenses with one custom-field request per 75 expense ids, a loop that had reached
51,386 calls in Production with a maximum execution time of 7,984.9 ms against the
`authenticated` role's 8,000 ms `statement_timeout`.

This pass moves scope resolution, authorization, filtering, custom-field enrichment and
report-row grouping into one versioned server RPC that returns bounded pages inside a
single jsonb envelope, and adds a client export coordinator that refuses to build a file
unless it can prove it holds every row of a single consistent snapshot. The workbook
format and semantics are unchanged.

Affects every organization using the `daily_project_expense_report` feature. MicroLink
is the org at risk today: **10,111 approved expenses → 4,160 report rows**, of which the
old pipeline could see at most 1,000 expenses (~9.9%).

---

## 2) Problem / requirement

### 2.1 Silent truncation (the missing rows)

`src/lib/buildDailyProjectExpenseReport.ts` built its expense query with no `.range()`
and no `.limit()`:

```ts
supabase.from("expenses")
  .select("id, user_id, trip_start, category, total_amount, title,
           destination, purpose, transaction_number")
  .eq("organization_id", organizationId)
  .eq("status", "approved")           // + optional trip_start range
  .order("trip_start", { ascending: true })
```

PostgREST injects its own `LIMIT` (`db-max-rows`) on unbounded requests. Production
`pg_stat_statements` holds that exact query, normalised, with a `LIMIT` the client never
wrote:

```
WHERE "expenses"."organization_id" = $1 AND "expenses"."status" = $2
ORDER BY "expenses"."trip_start" ASC LIMIT $3 OFFSET $4
```

This deployment's cap is 1,000, already proven from a HAR capture in
[DOC-074](./review-expenses-loading-blocker.md) (`Content-Range: 0-999/*`) — the same
defect class, in a different feature, left unfixed here.

**No error was surfaced.** The workbook was generated from whatever arrived.

### 2.2 Timeout on custom-field enrichment (the failing request)

The same file then looped expense ids in chunks of 75, sequentially, one
`expense_form_field_values` request each. Production `pg_stat_statements` for that
statement:

| metric | value |
|---|---|
| calls | **51,386** |
| total_exec_time | **12,267 s** (~3.4 h of cumulative DB time) |
| mean_exec_time | 238.7 ms |
| stddev_exec_time | 602.3 ms |
| **max_exec_time** | **7,984.9 ms** |

`pg_roles.rolconfig` shows `authenticated` → `statement_timeout=8s` (and `authenticator`
→ `8s`, `anon` → `3s`; the database default is `0`). A 7,984.9 ms maximum against an
8,000 ms ceiling is the signature of executions being cancelled at the limit — the
request that "stops before the complete dataset is returned".

### 2.3 What is NOT the problem

Measured read-only on Production under the real `authenticated` role with RLS active:

| query | plan | time |
|---|---|---|
| the report's expense scan, all 10,111 rows | Seq Scan + quicksort | **56.8 ms** |
| the same scan bounded to 1,000 | Seq Scan + top-N | 35.0 ms |
| one 75-id custom-field chunk | Index Only Scan `idx_efv_org_expense_covering` | 30.4 ms |
| **all** custom-field enrichment, set-based, whole org, one statement | Hash Left Join | **349 ms** |

The database is not slow. The architecture was: 51,386 round trips to do 349 ms of work,
and an unbounded request that could only ever return a tenth of the data.

---

## 3) Solution

### 3.1 Old architecture

```
Generate Report (tab "daily")
        ↓
dailyQuery (React Query)  →  loadDailyReport()
        ↓
fetchDailyProjectExpenseReportRows()
        ↓
[1] ONE unbounded expenses request        ← PostgREST silently caps at 1000
        ↓
[2] fetchExpenseSubmitterProfiles()        ← chunked 100/req, Promise.all
        ↓
[3] fetchFieldValuesForMappings()          ← chunked 75/req, SEQUENTIAL, 51,386 calls
        ↓
[4] client resolves project id/name/location per expense
        ↓
[5] buildDailyProjectExpenseReportRows()   ← group, bucket costs, percent, sort
        ↓
downloadDailyProjectExpenseReportFile()    ← XLSX/CSV
```

### 3.2 New architecture

```
Generate Report (tab "daily")
        ↓
dailyQuery (React Query — one in-flight fetch per key, gives us its AbortSignal)
        ↓
runDailyProjectReportExport()              ← export coordinator
        ↓            ↑
   page 1 …  page N  │  keyset cursor + pinned snapshot, sequential (concurrency 1)
        ↓            │
get_daily_project_report_page_v1()         ← ONE jsonb envelope per call
   authorized_scope  → auth.uid() + active membership + report permission
   filtered_base     → org, approved, date range, user scope, snapshot
   enriched          → set-based LATERAL joins for the mapped fields
   grouped           → (trackDate, user_id, projectId) + cost buckets
   page_rows         → keyset slice, LIMIT p_page_size
        ↓
completeness gate: unique identities === authoritative total_count
        ↓
finalizeDailyReportGroups()                ← SHARED with the legacy path
        ↓
downloadDailyProjectExpenseReportFile()    ← unchanged
```

### 3.3 Report row identity

A Daily Project Report row is **not** an expense. `buildDailyProjectExpenseReportRows`
groups expenses by `(trackDate, user_id, projectId)`. On MicroLink that is
10,111 expenses → 4,160 rows. The export's identity, cursor and duplicate detection all
use that tuple, verified unique in Production:

```
source_expenses 10111 | report_rows 4160 | distinct_keys 4160
expenses_covered 10111 | grouped_amount 2,281,670.27 | source_amount 2,281,670.27
```

Zero rows dropped, zero amount drift, and the keyset key is unique — so keyset paging
over it cannot skip or repeat a row. Keyset boundary check at page 1: `250` returned,
`3,910` remaining after the cursor, `4,160 − 250 = 3,910`. Exact.

### 3.4 Output parity is structural, not just tested

Rather than reimplement row shaping server-side, the grouping tail of
`buildDailyProjectExpenseReportRows` was extracted into `finalizeDailyReportGroups`,
and **both** pipelines now call it. Sorting stays in JavaScript because the existing
comparator uses `String.prototype.localeCompare`, which Postgres collations do not
reproduce byte-for-byte; `percent` is likewise derived on the client from the complete
assembled set via the existing `payrollPercentForEmployeeDay`. The server returns
`projects_in_employee_day` as a cross-check, asserted in tests.

Preserved exactly: file types (`.xlsx` / `.csv`), file name
(`daily-project-expense-report-{from}-to-{to}` / `-all-time`), single sheet
`Daily Project Report`, all 23 headers in order, column widths, `Presence` = `"P"`,
blank-vs-zero behaviour for unmapped cost columns, `Track Date` as `DD-MM-YYYY`,
`percent` as a number, row ordering, source-expense drill-down ordering, the
`isDailyReportRowNeedsReview` amber flag, and the CSV BOM + quoting rules.

### 3.5 Failure is visible, never partial

Any of these throws and no workbook is produced: page failure after retries, malformed
envelope, unsupported `schema_version`, missing/invalid cursor, `has_more` with no
cursor, a duplicate logical row, a snapshot change mid-export, a missing authoritative
total, or `unique identities ≠ total_count`. The Reports page renders a plain-language
message (`daily.errors.*`, EN/HI/GU) that always states no partial report was generated.

### 3.6 Security

`get_daily_project_report_page_v1` is `SECURITY DEFINER` with `SET search_path = public`,
fully-qualified objects, `REVOKE` from `PUBLIC` and `anon`, `GRANT EXECUTE` to
`authenticated` only. It resolves the caller from `auth.uid()`, requires an **active**
membership in `p_organization_id`, and enforces the report permission rule server-side —
previously that rule existed only in the browser (`useCashierCapabilities`,
`TEAM_REPORTS_LEADER_ROLES`):

* org-wide: `admin`, or an accountant-cashier while `cashier_accountant_mode` is enabled
* team-scoped: `admin` / `engineer` / `team_leader` / `executive`

`p_organization_id` is validated, never trusted. The mapping config is read from
`organization_settings` server-side rather than accepted from the client. No RLS policy
was broadened.

---

## 4) Key files

```
supabase/migrations/20260820160000_daily_project_report_server_pagination.sql   (new)
supabase/rollbacks/20260820160000_daily_project_report_server_pagination_rollback.sql (new)
src/lib/dailyProjectReportPaging.ts                       (new — contract + coordinator)
src/lib/__tests__/dailyProjectReportPaging.test.ts        (new — 35 tests)
src/lib/buildDailyProjectExpenseReport.ts                 (extract finalizeDailyReportGroups)
src/pages/Reports.tsx                                     (rewire dailyQuery, progress, errors)
src/locales/{en,hi,gu}/reports.json                       (progress + 12 error strings)
```

Deliberately **not** changed: `src/lib/exportDailyProjectExpenseReport.ts` (the workbook
formatter is correct and stays client-side), `src/lib/dailyExpenseReportConfig.ts`,
`src/components/DailyExpenseReportMappingSection.tsx`,
`src/components/DailyReportSourceExpensesSheet.tsx`, and every non-daily report tab.

---

## 5) Database / migrations

```
supabase/migrations/20260820160000_daily_project_report_server_pagination.sql
supabase/rollbacks/20260820160000_daily_project_report_server_pagination_rollback.sql
```

Contents (all additive):

| object | purpose |
|---|---|
| `daily_report_cost_column_v1(text, jsonb)` | mirrors `resolveCategoryToCostColumn` |
| `_daily_report_parse_source_v1(text)` | mirrors `parseFieldSource` |
| `_daily_report_base_value_v1(...)` | mirrors `resolveMappedFieldValue`'s base branch |
| `daily_report_caller_can_view_v1(uuid, boolean)` | server-side report permission |
| `get_daily_project_report_page_v1(...)` | the paged report contract |
| `expenses_daily_report_scope_idx` | partial index, see §8 |

**NOT APPLIED TO PRODUCTION. The user runs SQL manually.** After applying, reload the
PostgREST schema cache so the new RPC is exposed.

⚠️ **The migration has not been executed against any database.** No staging instance and
no local superuser credential were available in this session, and running DDL on
Production was explicitly out of scope. Its *logic* was validated by running the
equivalent inline SQL read-only against Production (§3.3), but its *DDL and PL/pgSQL
syntax are unverified*. Apply it to a restore/staging environment first — the repo has
`npm run post-restore:migrations` for exactly this.

---

## 6) Response contract

```jsonc
{
  "schema_version": 1,
  "snapshot_at": "2026-08-20T05:00:00Z",
  "page_size": 250,
  "total_count": 4160,        // FIRST page only; null thereafter
  "returned": 250,
  "has_more": true,
  "next_cursor": { "track_date": "…", "user_id": "…", "project_id": "…" },
  "rows": [ /* ≤ page_size report-ready rows */ ]
}
```

The snapshot anchors on `expenses.created_at <= snapshot_at`, which is immutable — so
*editing* an expense mid-export cannot silently remove it from the population. Only an
approve/unapprove during the export changes the set, and the `total_count` assertion
catches that and refuses the file.

---

## 7) Page size

Server clamp: 1–500. Client default: **250**.

The full grouped computation over MicroLink's whole scope measures **545 ms**
(`EXPLAIN ANALYZE`, authenticated role) — every candidate size cleared the 8,000 ms
ceiling by more than 13×, so the choice was made on payload and page count rather than
on timeout headroom: 250 keeps a page near ~0.6 MB and the whole export at 17 pages.
500 halves the page count for a ~1.2 MB page; 100 gives 42 pages. 1,000 was rejected on
principle — the design must not encode PostgREST's cap anywhere.

Concurrency is **1**. Keyset paging is inherently sequential (page N+1 needs page N's
cursor), and fanning out would put avoidable load on a shared database.

---

## 8) Query plan / index justification

The report scan is `WHERE organization_id = $1 AND status = 'approved' [AND trip_start
BETWEEN …] ORDER BY trip_start`, and the keyset probes `(trip_start, user_id)`.

Plan **before** the index (Production, authenticated role, RLS active):

```
Sort  (actual time=33.033..45.390 rows=10111)
  Sort Key: trip_start
  ->  Seq Scan on expenses  (actual time=0.154..17.645 rows=10111)
        Filter: (organization_id = … AND status = 'approved')
        Rows Removed by Filter: 7896
Execution Time: 56.795 ms
```

None of the five existing `expenses_rq2_*` indexes serve this: they are keyed on
`COALESCE(updated_at, created_at)` or on `assigned_*_id`. Hence exactly one new index:

```sql
CREATE INDEX expenses_daily_report_scope_idx
  ON public.expenses (organization_id, trip_start, user_id)
  WHERE status = 'approved';
```

Partial, so it carries only the 10,111 approved rows of 18,007. Trade-off: one extra
btree on a table taking a few hundred writes a day — negligible. **No other index was
added**; nothing else in the plan was proven to need one.

---

## 9) Measurements (Production, read-only)

| measurement | value |
|---|---|
| MicroLink approved expenses | 10,111 |
| MicroLink report rows (groups) | 4,160 |
| distinct submitters in scope | 208 |
| custom-field rows for approved expenses | 48,168 (avg 4.64/expense, max 5) |
| `authenticated` statement_timeout | 8,000 ms |
| report expense scan (RLS, authenticated) | 56.8 ms |
| set-based enrichment, whole org, 1 statement | 349 ms |
| full grouped computation, whole scope | 545 ms |
| old: custom-field chunk calls | 51,386 (max 7,984.9 ms) |
| new: server calls for a full 4,160-row export | **17** |

---

## 10) Test plan

`src/lib/__tests__/dailyProjectReportPaging.test.ts` — 35 tests, all passing:

* **contract**: valid envelope; unsupported `schema_version`; malformed envelope
  (non-object / no rows / no snapshot); `has_more` without cursor; invalid cursor
* **row mapping**: `DD-MM-YYYY` formatting; empty date; numeric-string coercion;
  unknown cost column → `other_exp`
* **paging**: single page; multi-page with one pinned snapshot; >1,000 rows (no cap
  regression); **9,000 rows → 9,000 rows, 9,000 unique identities, 36 pages**;
  boundaries at 0 / 1 / 249 / 250 / 251; progress against the authoritative total;
  peak concurrency is 1
* **failure modes**: count mismatch; duplicate row; snapshot change; missing total;
  retry re-requests the identical cursor; retries exhausted → `page_failed`; contract
  violations are not retried; cancel mid-export yields no rows; already-aborted signal
  never issues a request
* **parity**: identical workbook rows and order vs `buildDailyProjectExpenseReportRows`
  on the same fixture; identical again at page size 1 (three page splits) including
  `percent` 50/50 vs 100 and blank-not-zero cells; drill-down source expenses and
  labels preserved; agreement with the server's `projects_in_employee_day`

Still to do — see §11.

---

## 11) Remaining risks / not yet proven

1. **The migration has never been executed** (see §5). Highest-priority gap.
2. **Server-side behaviour is unverified end-to-end.** Every test exercises the client
   against a simulated server. The SQL's own grouping logic was validated by inline
   read-only equivalence on Production, but the RPC itself has not been called.
3. **No browser QA.** The Reports UI was not driven with a real session, so progress
   rendering, cancel, error display and a real downloaded file remain unverified.
4. **Real-world timings are DB-side only** — no end-to-end wall-clock, payload size,
   browser parse time or workbook-generation time was measured against the live RPC.
5. **`lower()` vs JS `toLowerCase()`** for category matching: identical for ASCII
   category names (all current mappings), could differ for exotic Unicode.
6. **Voucher/merge determinism.** The legacy code took the first non-empty value in
   whatever order the DB returned rows within equal `trip_start`; the RPC orders by
   `(trip_start, id)`. This is strictly more deterministic and matches the old result
   whenever the old result was itself deterministic.
7. **Per-page cost is O(scope)** for the grouping CTE. At 10k it is 545 ms. The cursor
   prunes the expense-level scan, but a 50k-row org should be re-measured before
   assuming headroom.
8. **`i18n:check` is broken on `main`** (`node scripts/i18n-check-keys.ts` →
   `ERR_UNKNOWN_FILE_EXTENSION`) — pre-existing, not caused here. Key parity across
   en/hi/gu was verified manually (88 keys, zero missing, zero extra).

---

## 12) Quality gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vite build` | exit 0, built in 29.20s |
| `npx vitest run` (this branch) | 3384 passed, 10 failed / 187 files |
| `npx vitest run` (pristine `origin/main`) | 3350 passed, 9 failed / 186 files |
| `npm run migrations:check` | new migration not flagged (14-digit timestamp OK) |
| `npm run security:secrets` | clean |
| `npx eslint` (changed files) | new files clean; `Reports.tsx` 15 problems — **identical count on `origin/main`** |
| `git diff --check` | clean |
| `npm run i18n:check` | pre-existing failure on `main`, see §11.8 |

The failing test files are identical on both branches
(`MobileExpenseForm`, `efStructuredResponseParsing`, `receiptFinalization`,
`MaintenanceHistoryTab`, `repair6546Level2RoutingAndAudit`) — none touch reporting. The
10th vs 9th failure is one flaky test under full-suite load; running those five files in
isolation gives exactly 9 failures on **both** branches.

---

## Revision log

| Date | Rev | Change | By |
|------|-----|--------|-----|
| 2026-08-20 | 1.0 | Initial: forensic audit proving the 1,000-row PostgREST cap and the 51,386-call / 7,984.9 ms custom-field timeout from Production `pg_stat_statements`; new `get_daily_project_report_page_v1` contract + helpers + one justified partial index (migration and rollback written, **not applied**); export coordinator with pinned snapshot, keyset cursor, single-flight, cancel, retry, duplicate detection and a hard completeness gate; shared `finalizeDailyReportGroups` so both pipelines produce identical output; 35 new tests. Branch `hotfix/daily-project-report-server-scalability` only — not merged, not pushed, no Production SQL executed. | Agent |
