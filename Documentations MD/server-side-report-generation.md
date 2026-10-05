# Server-Side Report Generation (Claim Verification, Claim Approval, Detailed Expense, Daily Project Report)

**Doc ID:** DOC-106
**Status:** in progress
**Last updated:** 2026-08-27
**Owner / area:** Reports (`/reports`), Supabase Edge Functions

---

## 1) Summary

Moves report generation for all four Reports tabs off the browser and onto a durable, server-owned job queue (`report_export_jobs`) drained by a Supabase Edge Function worker (`run-report-export-job`). Claim Verification, Claim Approval and Detailed Expense previously fetched every matching expense into the tab with **no row cap at all** on the org-wide path — a documented, live silent-truncation bug (Claim Approval/Detailed Expense could export ~10% of the data with no error shown on a large organization). Daily Project Report already had server-side *pagination* (`get_daily_project_report_page_v1`, shipped separately on `main`) but still required the browser to stay open for the whole export. Generate now enqueues a job; the browser may leave; the worker builds the CSV and uploads it to a private bucket; each tab shows its own generation history with re-download.

This is a **repo-only integration** of previously unmerged work — no code here was written from scratch. It combines and adapts three separate, never-merged branches (see §9) into one coherent, current-`main`-compatible implementation. Nothing in this document has been applied to any database.

---

## 2) Problem / requirement

1. **Claim Verification / Claim Approval / Detailed Expense**: plain, unbounded PostgREST queries against `expenses` (no `.range()`/`.limit()`), exposed to this deployment's row cap. Same class of bug the Daily Project Report already had before its own server-side pagination shipped.
2. **Daily Project Report**: already paginated server-side, but the coordinator runs in the browser — closing the tab loses the export, and a large organization means holding the whole result set in a JS buffer for the whole run.
3. None of the four report types had any generation history — regenerating an identical report was the only way to get yesterday's file again.

## 3) Solution

- **New job queue** (`report_export_jobs`): one row per generation request, full lifecycle (`queued → running → completed | failed | cancelled`), per-organization concurrency cap, `FOR UPDATE SKIP LOCKED` claiming, heartbeat + stale-job recovery, 7-day expiry.
- **New worker** (`supabase/functions/run-report-export-job`): claims one job, pages the report's rows server-side via a bounded, cursor-based RPC, builds the CSV (RFC 4180 escaped, UTF-8 BOM), uploads to the private `generated-reports` bucket, completes the job. **Fails closed**: never marks a job `completed` if the assembled row count disagrees with the server-reported total.
- **Frontend**: one shared component, `ServerReportExportPanel`, parameterized per report type — Generate → poll → Download, plus a "Report history" list scoped to that report type with re-download and an honest "File expired" state (never a button that would 404).
- **Daily Project Report is additive, not a replacement**: its existing client-side coordinator (`dailyProjectReportPaging.ts` + `runDailyProjectReportExport`), fail-closed completeness gate, and source-expense drill-down (`DailyReportSourceExpensesSheet`) are **unchanged and still the primary experience**. `ServerReportExportPanel` is offered alongside it as a background-generation option for large exports where staying on the page isn't wanted. This is a deliberate asymmetry from the other three tabs — see §8.
- **Bug fix bundled in, not scope creep**: `report_daily_project_rows_v1` (the shared core both the existing foreground RPC and the new worker call) fixes two real, documented defects found by the two source branches this was ported from — blank `project name` on rows whose value is a nested sub-option, and a per-row category lookup that measured above the `authenticated` role's statement timeout at realistic data volumes. `get_daily_project_report_page_v1`'s signature and JSON contract are unchanged; only its internals improve.
- **Report tab refetch-storm fix, bundled in**: `Reports.tsx` overrode the app-wide React Query defaults back to the most aggressive settings available (`staleTime: 0`, `refetchOnMount: "always"`, `refetchOnWindowFocus: true`) — every tab switch re-ran whatever query was active. Now aligned with the global policy (`App.tsx`); freshness is preserved by the page's existing realtime invalidation on `expenses`.

## 4) Key files

```
supabase/migrations/20260827150000_report_export_jobs.sql
supabase/migrations/20260827160000_daily_project_report_shared_core.sql
supabase/migrations/20260827170000_server_side_expense_reports.sql
supabase/migrations/20260827180000_report_export_history.sql
supabase/functions/run-report-export-job/index.ts
supabase/functions/run-report-export-job/expenseReports.ts
supabase/config.toml                                            (added [functions.run-report-export-job])
src/lib/reportExportJobs.ts
src/components/ServerReportExportPanel.tsx
src/pages/Reports.tsx                                            (wired all four tabs)
src/lib/__tests__/serverSideReportGeneration.test.ts
src/lib/__tests__/reportExportWorker.test.ts
src/lib/__tests__/reportExportJobs.test.ts
src/pages/__tests__/reportsServerSideGeneration.test.ts
src/components/__tests__/ServerReportExportPanel.test.tsx
src/lib/__tests__/reportsLoadingFix.test.ts                      (updated for the removed client preview)
```

## 5) Database / migrations

Apply in order — user runs SQL manually; **reload the PostgREST schema cache after applying** (`NOTIFY pgrst, 'reload schema'`), or the worker fails with "Could not find the function ... in the schema cache":

1. `20260827150000_report_export_jobs.sql` — job table, RLS, lifecycle functions (claim/heartbeat/complete/fail/recover/expire/cancel), `generated-reports` private bucket + storage policy. No rollback file — table/functions/bucket are all `CREATE ... IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, safe to re-run.
2. `20260827160000_daily_project_report_shared_core.sql` — adds `report_daily_project_rows_v1` (service-role-only core) and `CREATE OR REPLACE`s `get_daily_project_report_page_v1` to delegate to it. **This replaces a function already on `main`** (`20260820160000_daily_project_report_server_pagination.sql`) — signature and JSON return shape verified unchanged field-by-field before writing this file; only the internals (project-name resolution, category-lookup performance) improve.
3. `20260827170000_server_side_expense_reports.sql` — `report_expense_rows_v1`, `report_expense_allocations_v1`, custom-field resolution helpers, `create_expense_report_export_job_v1` (Claim Verification/Approval/Detailed Expense enqueue).
4. `20260827180000_report_export_history.sql` — `list_report_export_jobs_v1` (per-report-type generation history).

**Timestamps were deliberately renumbered from every source branch.** The source migrations used `20260820170000`/`20260820180000` (from `feature/daily-project-report-export-jobs`) and `20260822120000`/`20260822160000` (from `feature/preet-patel-changes`) — the latter collides with an already-shipped, unrelated migration on `main` (`20260822120000_form_template_search_configured_only_filter.sql`). All four were renumbered into one coherent `20260827` sequence rather than partially reusing old timestamps.

No Production SQL executed. No migration applied to any database this session.

## 6) Test plan

- [ ] Apply all four migrations (in order) to a non-Production database; reload the PostgREST schema cache.
- [ ] Deploy the `run-report-export-job` Edge Function (not done this session — code integration and testing only).
- [ ] As an admin, open `/reports` → Claim Verification → set filters → Generate → confirm it enqueues, polls, and offers a CSV download; open the file and confirm columns/balances match the pre-integration client export for the same filters.
- [ ] Repeat for Claim Approval and Detailed Expense (both "All employees" flat list and single-employee ledger modes).
- [ ] Daily Project Report: confirm the existing Generate/download/drill-down flow is unchanged, then use the new "Generate report" panel below it for a background export; confirm both produce identical row counts/totals for the same filters (they share `report_daily_project_rows_v1`).
- [ ] Generate a report, reload the page — confirm the completed job and history survive the reload.
- [ ] Wait past a job's `expires_at` (or manually null `storage_path`) and confirm history shows "File expired" with no download button.
- [ ] Confirm a second org's admin cannot see or download another org's generated report (RLS on `report_export_jobs` and the storage bucket).
- [ ] Automated: `npx vitest run src/lib/__tests__/serverSideReportGeneration.test.ts src/lib/__tests__/reportExportWorker.test.ts src/lib/__tests__/reportExportJobs.test.ts src/pages/__tests__/reportsServerSideGeneration.test.ts src/components/__tests__/ServerReportExportPanel.test.tsx src/lib/__tests__/reportsLoadingFix.test.ts` — 95/95 passing as of this doc.

## 7) Known limitations / deliberately deferred

- **No scheduler for `recover_stale_report_export_jobs_v1` or `expire_report_export_files_v1`** anywhere in this repository — both must be invoked periodically by an external scheduler (e.g. `pg_cron`) once this ships. Confirmed absent on every source branch, not just this integration.
- **Export format is CSV-only** for the worker path, even though `report_export_jobs.format` still allows `xlsx` — matches the explicit decision already made and documented on the source branches (xlsx/pdf/json generation was dropped when moving server-side).
- **No live database or Deno runtime was available this session** — all SQL and the Edge Function were verified by static source review and schema cross-reference against `main`'s actual table definitions (see the commit history for the specific columns verified), not by execution. `deno check` could not be run (Deno not installed in this environment).
- **`daily-report-remarks-column` is NOT part of this integration** — it depends on this worker architecture and is intentionally deferred to its own integration branch, per instruction.
- **`daily-report-data-recovery-and-render` is NOT part of this integration.**
- **`admin-submit-expense-for-employee` is NOT part of this integration.**
- **`balance-ledger-bulk-import` is NOT part of this integration.**

## 8) Design decisions worth recording

- **Two competing persistence architectures existed across the source branches; one was excluded as dead.** `feature/preet-patel-changes`'s first commit (`d4be914`) also introduced `generated_reports`/`generated_report_runs` ("Option A" — content-hash-deduplicated snapshots, `SavedReportsPanel.tsx`, `generatedReportStore.ts`). That commit's own message states: *"Known overlap: report_export_jobs (DOC-102) is already applied to Production but dormant... It is a better substrate for large file exports... do not run both as competing stores."* Proof this was abandoned, not just documented as a risk: the very next commit (`a82fec9`) disabled the only query that fed it (`enabled: false && ...` added to the Daily Project Report's `dailyQuery`), and it was never wired to the other three report types even after they were converted to server-side generation two commits later. **Excluded from this port**: `20260823100000_generated_report_snapshots.sql` and its rollback, `src/lib/generatedReportStore.ts`, `src/components/SavedReportsPanel.tsx`.
- **`report_export_jobs`'s own table/lifecycle schema does not exist on `feature/preet-patel-changes` at all** — it was built on a fourth, separate, never-merged branch, `feature/daily-project-report-export-jobs` (`20260820170000_report_export_jobs.sql`, `20260820180000_daily_project_report_shared_core.sql`). That branch also built its own competing Daily-Project-Report-only Node/Docker worker and frontend (`worker/`, `GeneratedReportsCard.tsx`, `useReportExportJobs.ts`, `ReportExportJobService.ts`) — **excluded from this port**, since `feature/preet-patel-changes`'s Edge-Function worker + `ServerReportExportPanel` supersede it with a design that covers all four report types uniformly, not just Daily Project Report.
- **Daily Project Report is additive, the other three are a full replacement.** The other three tabs had a genuinely broken, unbounded fetch with no existing safety net — replacing it fixes a live bug. Daily Project Report's existing client-side path is already safe (bounded, keyset-paginated, fail-closed) and has a valuable drill-down feature with its own test coverage (`reportsLoadingFix.test.ts` originally asserted on its exact preview-table wiring) — removing it would be a pure regression for no correctness gain, so it was kept and the new panel added alongside it instead.
- **Authorization reuses `daily_report_caller_can_view_v1` for all four report types**, not a new function per type. Verified by direct code comparison, not assumption: the client's `canAccessReports`/`canViewTeamReports` gates (`useCashierCapabilities.ts`, `Reports.tsx`) resolve to the exact same role/membership/feature-flag logic this SQL function already implements for both the team-scoped and non-team-scoped cases.
- **`create_expense_report_export_job_v1`'s dedupe key deliberately omits the requester** (org-wide dedupe — two people in the same org asking for identical filters share one job), unlike the Daily Project Report's per-user dedupe. This is intentional, not an inconsistency: the RLS SELECT policy on `report_export_jobs` already lets any caller who can view a report type see every job of that type in their org.

## 9) Source branches / commits examined

- `origin/feature/preet-patel-changes` (primary porting reference): commits `d4be914`, `454b58a`, `0dac051`, `ccd814a`, `a82fec9`, `902a3f0`, `8372019`. `454b58a` (unrelated typecheck-breaking comment fix) was not needed — `main`'s `tutorialManuals.ts` never had that bug.
- `origin/Preet-Patel/feature/server-side-report-generation` (secondary reference, no shared ancestry with `main`): confirmed byte-identical to `feature/preet-patel-changes`'s tip for every file this integration touches — no later fix was found there that Branch A lacked.
- `origin/feature/daily-project-report-export-jobs` (discovered mid-audit, not in the original branch list, but load-bearing): supplied the `report_export_jobs` table/lifecycle schema and the corrected Daily Project Report shared core that `feature/preet-patel-changes` assumes already exists.

## 10) Related docs

- [`Documentations MD/index.md`](./index.md)
- Superseded reference only (excluded from this port): the "Option A" persistence design described in §8 above (no standalone doc file was ported; see the excluded migration/files list).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-27 | 1.0 | Claude Code | Initial integration on `integration/preet-server-side-report-generation`, branched from `main` @ `db58c27`. Ported and adapted 4 migrations (renumbered, one security-tightened, one race-hardened), the Edge Function worker verbatim, the client library and panel component verbatim, wired all four Reports tabs, fixed the report-tab refetch-storm bug. 95 new/updated tests, zero new TS/lint errors, zero new test failures against the pre-integration baseline. Not merged, not deployed, no Production SQL applied. |
