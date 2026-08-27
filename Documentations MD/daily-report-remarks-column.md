# Daily Project Report — populate the Remarks column

**Doc ID:** DOC-115
**Status:** authored for peso-bckup only. NOT applied to Production. Migration NOT yet applied to the backup database either (SSH host unreachable at commit time — see revision log).
**Last updated:** 2026-08-27
**Owner / area:** Daily Project Report export, `get_daily_project_report_page_v1`, `buildDailyProjectExpenseReport.ts`

---

## 1) Summary

The Daily Project Report's exported CSV/Excel has always had a "Remarks" column header, but it was never wired to any data source — every row shipped with it hardcoded to `""`. Each individual expense already carries its own free-text remark (the base `purpose` column, commonly relabeled "Remark" per organization — confirmed live in Batch Review, `BatchExpenseReviewPanel.tsx`). Since a Daily Project Report row is not one expense but a *group* of every expense sharing the same (track date, employee, project) — e.g. every line of one multi-line batch — this fix comma-joins each grouped row's underlying expenses' own remarks into that one row's "Remarks" cell.

## 2) Problem / requirement

User request, verbatim scenario: a 5-line batch (Auto / Doormatory / Private lucjury / Personal auto / Auto) submitted for one trip/project collapses into a single Daily Project Report row (confirmed grouping key: `track_date, user_id, project_id`). The report's Remarks cell for that one row should read `"Auto, Doormatory, Private lucjury, Personal auto, Auto"` — every line's own remark, comma-separated, in the batch's natural order, duplicates preserved (not deduplicated — five real expenses can legitimately share the same remark text).

Scope check performed before implementing: the other 3 reports (Claim Verification, Approval, Detailed Expense) do **not** group multiple expenses into one row at all — their backing RPC (`report_expense_rows_v1`) has no `GROUP BY`, one row per expense — and none of them define a "Remark"/"Remarks" header in the first place. So there is nothing to build for those three; this fix is scoped to the Daily Project Report only.

## 3) Solution

- `source_expenses` (the jsonb array `get_daily_project_report_page_v1` already builds, one entry per underlying expense in a grouped row) now also carries `purpose`.
- `finalizeDailyReportGroups` (`src/lib/buildDailyProjectExpenseReport.ts`, shared by both the live server-paged pipeline and the legacy client-side one so they can never drift) computes the group's sorted source-expense list once, and sets `row["Remarks"]` by joining every non-empty `purpose` from that list with `", "` — same order the array is already emitted in (`trip_start`, then `category`), blank remarks skipped so they never leave a stray comma, duplicates kept.
- No new `fieldMappings` config key was needed — `purpose` is always a fixed base column, unlike `projectId`/`projectName`/`location` which are genuinely org-configurable.
- "Other Remarks" (the other header in `DAILY_PROJECT_REPORT_HEADERS`) has no backing field anywhere in the schema and was left untouched, staying blank as it always has — inventing a source for it was out of scope of this request.

## 4) Key files

```
supabase/migrations/20260827100000_daily_report_source_expense_purpose.sql
supabase/rollbacks/20260827100000_daily_report_source_expense_purpose_rollback.sql
src/lib/buildDailyProjectExpenseReport.ts (DailyReportSourceExpense.purpose, finalizeDailyReportGroups)
src/lib/dailyProjectReportPaging.ts (ServerSourceExpense.purpose, serverRowToGroup)
src/lib/__tests__/buildDailyProjectExpenseReport.test.ts (2 new tests)
```

## 5) Database / migrations

One new additive migration, `CREATE OR REPLACE` on `get_daily_project_report_page_v1` only (same signature — the deployed frontend keeps calling it unchanged). Adds `'purpose', g.purpose` to the existing `source_expenses` jsonb payload; every other line of the function body is byte-identical to `20260826100000_daily_report_dynamic_project_name.sql`.

## 6) Test plan

- [x] `finalizeDailyReportGroups` joins 5 batch lines' purposes into one Remarks cell, in order, keeping duplicates (`"Auto, Doormatory, Private lucjury, Personal auto, Auto"`)
- [x] Blank/null purposes are skipped, no stray comma
- [x] Existing 51 tests across `buildDailyProjectExpenseReport.test.ts`, `dailyProjectReportPaging.test.ts`, `exportDailyProjectExpenseReport.test.ts` all still pass (53 total after the 2 new ones)
- [x] `tsc --noEmit -p tsconfig.app.json`: 16 pre-existing errors in touched files, identical set to baseline, zero new
- [x] Clean production build
- [ ] Migration applied to the live backup database and verified against real data — blocked at commit time by an unreachable SSH host (transient network issue, not a code problem); see revision log for resolution

Backup instance only. NOT applied to Production.

---

## Revision log

| Date | Notes |
|---|---|
| 2026-08-27 | Initial implementation. Code, tests, typecheck, and build all verified clean. Migration authored but not yet applied — SSH host to the backup database was unreachable at commit time. Pushed to a feature branch, not merged to `main`, specifically so the deployed app and the database schema never drift out of sync; will apply the migration and verify live before merging. |
