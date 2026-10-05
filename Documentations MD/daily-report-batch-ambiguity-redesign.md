# Daily Project Report — Batch Ambiguity Redesign (Step 2, final)

**Doc ID:** DOC-110
**Status:** deployed
**Last updated:** 2026-08-29
**Owner / area:** Reports, Supabase (Daily Project Report)

---

## 1) Summary

Replaces the whole-population `project_name_ambiguous` computation inside
`report_daily_project_rows_v1` (from DOC-108 / `daily-report-data-recovery-render.md`)
with a narrow, page-scoped RPC, `get_daily_report_project_name_ambiguity_batch_v2`.
The whole-population design caused two real Production incidents when
activated (a 2+ minute hang, then a `plan_cache_mode` fix that still measured
~10.5–11.3s on real Production despite testing fast in an isolated copy) and
was never left live. `report_daily_project_rows_v1` is now restored to the
exact base architecture already proven in real Production use, with exactly
one addition: `expenses.purpose` carried through to
`source_expenses[].purpose` (Remarks, from DOC-107).

---

## 2) Problem / requirement

Computing ambiguity for one report page required scanning the organization's
entire approved-expense population through 4 LATERAL joins, on every page
call, regardless of query tuning. Two separate root-cause investigations
(session-level `plan_cache_mode` forcing, `plpgsql_check` instrumentation
analysis, `pg_stat_statements`-based execution-count proofs) confirmed the
double-execution and per-execution-cost mechanisms were real, but fixing them
in place never reliably cleared the 8-second authenticated statement_timeout
under real Production contention. The architecture itself — one full-table
scan to answer a question about one page — was the defect, not the tuning.

---

## 3) Solution

- `report_daily_project_rows_v1`: reverted to the pre-DOC-108 base query
  (same 4 LATERAL joins, same grouping/pagination), plus `f.purpose` added to
  `enriched`'s SELECT list and `'purpose', g.purpose` added to
  `source_expenses`'s `jsonb_build_object` (Remarks only — unchanged from
  DOC-107). No ambiguity computation happens in this function anymore.
- New RPC `get_daily_report_project_name_ambiguity_batch_v2(organization_id,
  project_ids[])`: resolves the org's `daily_expense_report_config`
  internally, then looks up only the supplied project ids via
  `effv_rq2_template_filter_idx` / `effv_rq2_branch_filter_idx`
  (composite indexes on `(organization_id, template_id|branch_field_id,
  field_value, expense_id)`) — confirmed via `EXPLAIN` to produce an `Index
  Only Scan`, total query cost ≈1,110 versus ≈600,000+ for the abandoned
  whole-population CTE. `base`-kind project-id mappings (no stored,
  indexable value) return `false` for every requested id rather than forcing
  a full-population scan — a deliberate, documented scope limit.
- Both the foreground page
  ([src/lib/dailyProjectReportPaging.ts](../src/lib/dailyProjectReportPaging.ts))
  and the export worker
  ([supabase/functions/run-report-export-job/index.ts](../supabase/functions/run-report-export-job/index.ts))
  extract the distinct project ids present on the page/rows they already
  have and call the batch RPC with only that set — never the organization's
  full population. Both use the identical RPC, so foreground and worker
  ambiguity decisions cannot drift.

---

## 4) Key files

```
supabase/migrations/20260829120000_daily_report_remarks_and_batch_ambiguity.sql
src/lib/dailyProjectReportPaging.ts
src/lib/dailyExpenseReportConfig.ts
src/lib/__tests__/dailyReportAmbiguityBatch.test.ts
src/lib/__tests__/dailyProjectReportPaging.test.ts
supabase/functions/run-report-export-job/index.ts
```

---

## 5) Database / migrations

`supabase/migrations/20260829120000_daily_report_remarks_and_batch_ambiguity.sql`
— applied to Production (`evo3o0fdjaroxq7uohrm21cp`) on 2026-08-29, after a
fresh checkpoint backup (`20260829T100151Z-pre-step2-batch-ambiguity-redesign`).
Supersedes the whole-population ambiguity CTE from
`20260827160000_daily_project_report_shared_core.sql`'s AMENDED 2026-08-27
(preet-daily-report-data-recovery-render) section and its later
`plan_cache_mode` patch (never left live). PostgREST schema cache reloaded
after apply (`NOTIFY pgrst, 'reload schema'`).

---

## 6) Test plan

- [x] Throwaway restore of Production data (12,601 real approved expenses,
      MicroLink): first page, `p_with_total=true/false`, cursor page — exact
      parity (`total_count=5078, source_count=12601,
      source_amount=2862550.27`).
- [x] `EXPLAIN` on the batch RPC's core lookup: `Index Only Scan` confirmed,
      cost ≈1,110 for a 2-id request.
- [x] Batch RPC tested with a page-sized id set (73) and the full
      organization's distinct id set (240) — both return correct,
      independent-of-request-size-cost results.
- [x] Production E2E: all four report types (Daily Project Report, Claim
      Verification, Claim Approval, Detailed Expense) generated end-to-end
      via the real worker — queued → running → completed → Storage →
      download → history → re-download. Claim Approval and Detailed Expense
      both exceeded 1,000 rows (12,601 each).
- [x] Downloaded Daily Project Report CSV inspected directly: real Remarks
      text present, `Ambiguous - multiple names on record, unresolved`
      marker present (3 occurrences), `N/A - no data on record` marker
      present (59 occurrences) — both paths render correctly from the batch
      RPC's real output.
- [x] `vitest` — 7 new tests
      (`dailyReportAmbiguityBatch.test.ts`) plus the full existing suite,
      3,865/3,865 passing. `tsc --noEmit` clean. `npm run build` succeeds.

---

## 7) Related docs

- [daily-report-remarks-column.md](./daily-report-remarks-column.md) — the
  Remarks feature this preserves unchanged.
- [daily-report-data-recovery-render.md](./daily-report-data-recovery-render.md)
  — the original (abandoned) whole-population ambiguity design this replaces.
- [PENDING_MIGRATIONS_PREET_INTEGRATION.md](./PENDING_MIGRATIONS_PREET_INTEGRATION.md)
  — migration register, updated with this redesign's real disposition.
- [PRODUCTION_BACKEND_ACTIVATION_PLAN.md](./PRODUCTION_BACKEND_ACTIVATION_PLAN.md)
  — original activation plan; actual outcome differed from the plan's
  Migration 2 as originally authored (see that doc's outcome addendum).

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-29 | 1.0 | Claude Code | Initial doc: whole-population ambiguity design abandoned after two Production incidents; batch, page-scoped RPC designed, tested, and deployed to Production. |
