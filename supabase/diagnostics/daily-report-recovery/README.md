# Daily Project Report — Project Name/ID recovery diagnostics

STATUS: **NOT RUN. NOT APPLIED. NO DATABASE HAS BEEN TOUCHED.** Every file in
this directory is read-only analysis or a guarded, manually-gated template.
Nothing here executes automatically, and nothing here is wired into any
migration, Edge Function, cron job, or CI step.

Source: this package exists because
`Preet-Patel/feature/daily-report-data-recovery-and-render` performed real,
manual data-recovery writes into `expense_form_field_values` directly against
MicroLink's backup database (1,095 rows across three commits — 463 in
`ea66bf8`, 626 in `69bd0c0`, 6 in `703a556`). None of those writes exist as
runnable SQL anywhere in that branch's history — they were executed ad hoc
and only described in prose/tables in the commit messages. There is
therefore no executable code from that branch to "port but disable"; what
follows was built from scratch for this integration, scoped generically to
any organization (not hardcoded to MicroLink), and classified against the
same-safety rules that branch's writes were never held to.

## Why this is a diagnostic package, not a backfill script

`supabase/migrations/20260827160000_daily_project_report_shared_core.sql`
already resolves a blank "project name" at **read time**, with no data
mutation, via three fallback tiers inside `report_daily_project_rows_v1`:

1. the org's configured field mapping,
2. the project_name value actually submitted on that specific expense
   (`project_name_branch`),
3. the project's branch **definition**, only when it has exactly one
   possible option (`defn`).

Tier 3 is precisely Data-Recovery Class B from the classification below
("a branch has exactly one valid configured option") and tier 2 already
recovers the sub-case of Class A that matters for THIS report ("the value
was actually submitted but a different, blank-at-render field was being
read"). Both are already correct and already live in every report run,
**without writing anything** — which is strictly safer than materializing
the same values into `expense_form_field_values`, since a read-time
fallback can never leave a persisted table in a state that disagrees with
the fallback rule that produced it.

What this package adds is visibility: which rows *still* end up blank or
ambiguous after all three tiers, and why, so an owner can decide whether any
further *configuration* change (not a data write) closes the gap — e.g.
mapping `projectName` correctly, or retiring a duplicate branch definition
so tier 3 can fire. Layers 2/3 below exist only for the narrow, genuinely
deterministic residue that configuration alone cannot fix.

## Data-recovery classification (do not automate C–F)

| Class | Meaning | Write automatically? |
|---|---|---|
| A | Exactly one real value recorded elsewhere for the same Project Unique ID | Already covered at read time (tier 2/3 above) — no write needed |
| B | Exactly one valid configured branch option | Already covered at read time (tier 3 above) — no write needed |
| C | Unanimous batch-sibling inference | **No.** Inference, not fact. |
| D | Same-employee nearest-neighbor inference | **No.** Inference, even at high confidence. |
| E | Majority/ambiguous signal | **No.** This is exactly what the ambiguity marker exists to surface, not paper over. |
| F | No signal at all | **No.** Nothing to recover; renders as "N/A - no data on record". |

Preet's original backfill mixed A/B (deterministic) with C/D (inference)
under one heading ("Project Name recovery," "Project ID recovery — batch
sibling inference," "same-employee nearest-neighbor") without disclosing
which value came from which method. That is the exact failure mode Phase 8
of this integration's task exists to prevent: never describe an inferred
value as identical to original persisted truth. Nothing in this package
writes a Class C/D/E/F value under any circumstance.

## The three layers

1. **`01_read_only_analysis.sql`** — pure `SELECT`s, safe to run any time
   against any environment. Reports, per organization: how many report rows
   resolve via each tier, how many are still blank ("N/A"), and how many
   project ids are flagged ambiguous. Zero side effects.

2. **`02_prepared_materialization_dry_run.sql`** — pure `SELECT`, still zero
   side effects. Shows exactly which `expense_form_field_values` rows *would*
   be inserted, and the exact value each would receive, if an owner ever
   chose to materialize the Class A/B fallback into a real stored value
   (purely a performance/visibility optimization elsewhere in the app where
   the raw submitted value is read directly, outside this report — the
   report itself does not need this). Every candidate row is Class A/B only,
   by construction of the query, never C–F.

3. **`03_prepared_write.sql`** — the actual guarded `INSERT`, wrapped in a
   transaction, `NOT EXISTS`-guarded against the exact same predicate the
   dry run used (so a row the dry run didn't show cannot be written),
   organization-scoped by a required `:organization_id` parameter, and
   commented out end-to-end. **Requires manual owner review of the dry-run
   output, manual uncommenting, and manual execution.** It is not — and must
   never become — part of any migration, deploy step, or automated job.

4. **`04_post_write_verification.sql`** — pure `SELECT`s to run after any
   Layer 3 execution: exact row counts affected, exact expense ids touched,
   and a re-run of Layer 1's tier breakdown to confirm no row moved to a
   Class C–F value and no cross-organization write occurred.

## Safety properties (all four files)

- Every query requires an explicit `:organization_id` — there is no
  no-argument / all-organizations mode, and no hardcoded organization id
  (MicroLink's or otherwise) anywhere in this directory.
- Layer 3 is idempotent: re-running it after it has already run inserts
  nothing new, because its `NOT EXISTS` guard is against the same
  `(expense_id, organization_id, branch_field_id)` uniqueness the table
  already relies on elsewhere in this schema.
- Layer 3 only ever writes a value that Layer 1/2's own read-time formula
  would have produced anyway — it cannot introduce a value the report
  wouldn't already have shown.
- Rollback: Layer 3's `INSERT` records are identified by a literal
  `recovered_via = 'daily-report-recovery-2026-08-27'` tag value in a
  companion note (see the file's own header) so any run can be located and
  deleted by that tag alone if an owner ever needs to reverse it; no
  destructive statement is included in this package.
- No Production credentials, connection strings, or secrets appear in any
  file here — every file assumes it is pasted into whatever SQL console the
  owner already uses against whichever environment they explicitly choose.
- If used against MicroLink specifically, that is an owner decision at
  execution time, not something these files assume or default to.
