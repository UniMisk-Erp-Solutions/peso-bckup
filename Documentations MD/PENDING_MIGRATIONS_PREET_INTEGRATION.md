# Pending Database Migrations — Preet Integration

**Repository:** `Mithil1105/peso-patidar`  
**Current integration branch:** `integration/preet-admin-submit-expense-for-employee` (parent: `integration/preet-daily-report-data-recovery-render`, grandparent: `integration/preet-daily-report-remarks-column`, great-grandparent: `integration/preet-server-side-report-generation`)
**Status:** Production backend activation COMPLETE as of 2026-08-29 (SQL, PostgREST, Edge Functions). `main` NOT merged — pending the owner's own frontend QA.
**Database status:** **FINAL 2026-08-29 — see `Documentations MD/daily-report-batch-ambiguity-redesign.md` (DOC-110) for the Migration 2 outcome, and `PRODUCTION_BACKEND_MIGRATION_AUDIT.md` for the original audit evidence.** Migrations 1, 3, 4 remain RETIRED (live, already-adequate). Migration 2 was attempted TWICE as originally authored (whole-population ambiguity) and rolled back both times on real Production; the final, deployed version is a redesign (DOC-110), not the file this register originally described. Migrations 5 and 7 are now APPLIED. Migration 6 remains RETIRED (superseded, no replacement).
**Worker status:** `run-report-export-job` **deployed** to the PesoWise Edge Functions container 2026-08-29 and proven end-to-end for all four report types via the real worker (queued→running→completed→Storage→download→history→re-download). **Automatic dispatch also now complete** (DOC-111, 2026-08-29): the frontend's own `triggerExportWorker()` nudge was already correctly wired (no changes needed); added a host-cron backstop (`webadmin`'s crontab, every 2 minutes) for the case that nudge fails, and wired up the pre-existing but never-called `recover_stale_report_export_jobs_v1` for the case a worker dies mid-run. Verified: 4 real jobs drained with zero manual invocation. No SSH/curl is required for normal report generation anymore. `finalize-expense-receipts` redeployed 2026-08-29 with this branch's admin-authorization fix; the prior version is preserved at `/home/webadmin/edge-function-rollbacks/finalize-expense-receipts-v4-index.ts` on the Production host. Its separately-documented execution-timeout condition was inspected post-redeploy but not conclusively confirmed still occurring from server logs alone (see DOC-110's revision-log entry) — remains open, undocumented as fixed.

> This register is cumulative across every ported Preet module — despite the filename, it is now the controlled migration register for this entire integration lineage, not only Preet-sourced work. It currently covers **Server-Side Report Generation** (4 migrations), **Daily Project Report Remarks Column** (amends migration 2, adds no new migration file — see §2, Migration 2's Remarks amendment note), **Daily Report Data Recovery / Render** (amends migration 2 again, adds no new migration file — see §2, Migration 2's Ambiguity Flagging amendment note, and §5b), and **Admin Submit Expense for Employee** (2 new migrations — see §5c).
> Future Preet modules may add additional migrations; they should be appended here only after those modules are ported onto the current integration lineage.
> `Preet-Patel/feature/balance-ledger-bulk-import` is explicitly **SUPERSEDED / NO FURTHER INTEGRATION REQUIRED** — see §8, the branch closure table.
> **2026-08-29: do not treat any status in this section as current without reading `PRODUCTION_BACKEND_MIGRATION_AUDIT.md` first.** The statuses below are corrected in place, but that document carries the full evidence, confidence levels, and exact remaining delta per migration — required reading before authoring or applying anything further.

---

## 1. Pending migrations — corrected status per the 2026-08-29 Production audit

| Order | Migration | Status (corrected 2026-08-29) | Live audit evidence | Remaining delta | Provenance confidence |
|---|---|---|---|---|---|
| 1 | `20260827150000_report_export_jobs.sql` | **RETIRED — LIVE, DRIFT CONFIRMED HARMLESS, NO ACTION** | Table, RLS policy, private bucket, storage policy, and all lifecycle functions confirmed live AND body-identical (full diff, 2026-08-29). Two structural drifts remain by deliberate decision, not oversight: `format` column default is `'xlsx'` live vs `'csv'` in this file — proven inert, every enqueue path always explicitly passes `p_format`, defaulting to `'csv'` at the function-parameter level; live index `report_export_jobs_org_created_idx` differs in name/columns from this file's `report_export_jobs_org_type_created_idx` — proven to have no measurable performance impact at this table's real scale (a job queue with 7-day completed-job expiry). See `PRODUCTION_BACKEND_ACTIVATION_PLAN.md` for the full reasoning. | **None.** `create_expense_report_export_job_v1`'s missing `REVOKE FROM anon` is addressed by Migration 7 instead of this file. **DO NOT re-run this file** — nothing further to gain from it. | Base object (single-report-type): CONFIRMED (commit `15dd355`, 2026-08-20). 4-report-type broadening: STRONGLY INFERRED, no commit found. Functional-impact analysis: CONFIRMED (direct code inspection, 2026-08-29). |
| 2 | `20260827160000_daily_project_report_shared_core.sql` (amended for Remarks, 2026-08-27; amended again for Ambiguity Flagging, 2026-08-27) | **ABANDONED AS AUTHORED — see Migration 8** | Applied to Production twice as authored (whole-population ambiguity CTE), rolled back both times: a 2+ minute hang, then a validated `plan_cache_mode` fix that still measured ~10.5-11.3s on real Production. `report_daily_project_rows_v1` is now live on Production as the exact pre-amendment base plus only `f.purpose`/`source_expenses[].purpose` (Remarks) — see Migration 8 for where ambiguity actually lives now. **Do not apply this file's Ambiguity Flagging amendment to Production again as authored.** | None remaining for THIS file — superseded by Migration 8. | Base: CONFIRMED (commit `15dd355`, 2026-08-20). Ambiguity amendment: CONFIRMED unsafe on real Production (two live incidents, `pg_stat_statements`-proven root cause). |
| 3 | `20260827170000_server_side_expense_reports.sql` | **RETIRED — LIVE, BODY-CONFIRMED IDENTICAL, GRANT DELTA ONLY** | Full body diff of all 10 functions completed 2026-08-29 (`PRODUCTION_BACKEND_MIGRATION_AUDIT.md` §7): every function body identical to the branch. Two grant gaps confirmed: `create_expense_report_export_job_v1` and `_report_humanize_field_key_v1` both still `EXECUTE`-able by roles this file already intends to revoke. | Addressed entirely by Migration 7 (`20260829100000_report_export_grant_hardening.sql`). **Do not replay this file.** | STRONGLY INFERRED apply provenance; body equivalence CONFIRMED by direct diff, 2026-08-29. |
| 4 | `20260827180000_report_export_history.sql` | **RETIRED — LIVE, CONFIRMED SEMANTICALLY IDENTICAL** | `list_report_export_jobs_v1` confirmed live, full body diff completed 2026-08-29: identical JSON envelope, fields, downloadability logic, scoping, and grants. One cosmetic error-message wording difference only (same error code). | **None. Do not replay this file.** | STRONGLY INFERRED provenance; body equivalence CONFIRMED by direct diff. |
| 5 | `20260828100000_admin_submit_expense_for_employee_v2.sql` | **APPLIED — 2026-08-29** | Applied to Production after a fresh dependency-signature recheck confirmed no drift. `expenses.created_by_admin_id`, `admin_submit_expense_idempotency` (RLS forced, zero direct grants), `admin_submit_expense_for_employee_v2`, `admin_bulk_submit_expenses_v2` and routing helpers all verified live with correct grants (anon denied, authenticated/service_role as designed). No fake Production expenses created — schema/RPC verification only; real frontend QA is the owner's. | None. | CONFIRMED applied and verified, 2026-08-29. |
| 6 | `20260828110000_org_scoped_audit_logs_select.sql` | **RETIRED — SUPERSEDED BY LIVE OBJECT, CONFIRMED 2026-08-29** | The live `"Users can view audit logs of viewable expenses"` policy is a THIRD, already org-scoped, independently-evolved policy — proven, property by property, to satisfy every required security guarantee at least as strongly as this file's own proposal (`PRODUCTION_BACKEND_ACTIVATION_PLAN.md` §5: active same-org admin access preserved, unrelated-org admin denied, owner/assigned-engineer access unchanged, no broader access than intended). | **Final: do not apply this file, ever, as currently authored. No replacement migration will be written.** The file remains in the repository as historical record of the analysis, not as a deployment candidate. | UNKNOWN who/when applied the live version; no commit found. CONFIRMED (by direct property-by-property proof, not inference) to already satisfy the security property M6 exists to provide. |
| 7 | `20260829100000_report_export_grant_hardening.sql` (new, 2026-08-29) | **APPLIED — 2026-08-29** | Closed the ONE confirmed remaining gap from the full M3 body/grant diff (`PRODUCTION_BACKEND_MIGRATION_AUDIT.md` §7): `create_expense_report_export_job_v1` and `_report_humanize_field_key_v1` both had `EXECUTE` granted to roles their own source migration files already intended to revoke. Verified applied and unaffected by every subsequent Step 2 rollback. | None. | CONFIRMED applied and verified, 2026-08-29. |
| 8 | `20260829120000_daily_report_remarks_and_batch_ambiguity.sql` (new, 2026-08-29) | **APPLIED — 2026-08-29** | Replaces Migration 2's abandoned whole-population ambiguity design. `report_daily_project_rows_v1` restored to its proven base architecture plus Remarks only; new `get_daily_report_project_name_ambiguity_batch_v2(organization_id, project_ids[])` answers ambiguity for a caller-supplied set of project ids only, via `effv_rq2_template_filter_idx`/`effv_rq2_branch_filter_idx` (confirmed via `EXPLAIN`: `Index Only Scan`, cost ≈1,110 vs ≈600,000+ for the abandoned design). Foreground (`dailyProjectReportPaging.ts`) and worker (`run-report-export-job/index.ts`) both call the identical RPC with only their own page's project ids. See `daily-report-batch-ambiguity-redesign.md` (DOC-110) for full detail. | None. | CONFIRMED applied and verified end-to-end (real 4-report-type worker run), 2026-08-29. |

**No new migration file was added by the Remarks or Data-Recovery/Render integrations.** Both were folded into Migration 2 because they modify the same function and the response contract is additive in each case. **Admin Submit Expense for Employee genuinely needed two new migration files** (5 and 6) — but as the audit above shows, Migration 6 turned out to already be superseded by independent live changes, and Migration 5 remains the one genuinely clean, unapplied candidate among all six.

**2026-08-29 (forward-only migration package task):** every verification gap left open by the initial audit was closed (full M3/M4 body diffs, M1 functional-impact analysis, M5 fresh dependency re-check, M6 final disposition), identifying Migration 2 (full file) and Migration 5 as the deployment candidates, plus new Migration 7 for a grant-hygiene gap. Migrations 1, 3, and 4 are RETIRED (live and either identical or deliberately left with harmless drift); Migration 6 is RETIRED (superseded).

**2026-08-29 (Production activation, actual outcome — supersedes the plan above for Migration 2):** Migration 7 and Migration 5 applied to Production exactly as planned. Migration 2, applied as originally authored, caused a real 2+ minute Production incident and was rolled back; a second attempt (a validated `plan_cache_mode` fix) still measured ~10.5-11.3s on real Production and was also rolled back. Migration 2's whole-population ambiguity design was abandoned and replaced with new **Migration 8**, `20260829120000_daily_report_remarks_and_batch_ambiguity.sql` (see DOC-110), which is what is actually live on Production today. All of Migrations 5, 7, and 8 are confirmed applied and verified. `run-report-export-job` deployed and proven end-to-end for all four report types. `finalize-expense-receipts` redeployed with its admin-authorization fix, prior version preserved as a named rollback. Data recovery/backfill NOT run. `main` NOT merged.

---

## 2. Migration details

### Migration 1 — Report export job infrastructure

**File**

`supabase/migrations/20260827150000_report_export_jobs.sql`

**Status**

**NOT APPLIED**

**Purpose**

Creates the durable background-report infrastructure used by all four report types:

- Daily Project Report
- Claim Verification
- Claim Approval
- Detailed Expense

The migration adds:

- `report_export_jobs`
- indexes
- RLS
- lifecycle functions
- private generated-report storage bucket
- storage policies

It is intended to be additive and does not modify an existing table or application RPC.

**Important**

Do not run this alone and then expose the new frontend as a completed feature. The rest of the migration chain and worker deployment are required before the server-side report workflow is operational.

---

### Migration 2 — Daily Project Report shared server core

**File**

`supabase/migrations/20260827160000_daily_project_report_shared_core.sql`

**Status**

**NOT APPLIED**

**AMENDED 2026-08-27 for the daily-report-remarks-column integration** — see below. This migration has still never been applied anywhere, so this was an in-place edit of the pending function body, not a second `CREATE OR REPLACE` layered on top.

**Purpose**

Adds the server/worker-side Daily Project Report core:

- `report_daily_project_rows_v1`

It also changes the implementation of the already-existing:

- `get_daily_project_report_page_v1`

using `CREATE OR REPLACE`.

Its signature and JSON contract are intended to remain compatible with the current frontend, but because this is an already-shipped RPC, this is the migration requiring the most care.

**Remarks amendment (2026-08-27)**

Two lines added inside `report_daily_project_rows_v1`, nothing else in this function changed:

1. The `enriched` CTE now carries `f.purpose` forward (it was being selected by `filtered` already, for the base-field project/location resolution, but `enriched`'s explicit column list was dropping it before it could reach `source_expenses`).
2. The `grouped` CTE's `source_expenses` `jsonb_build_object(...)` now includes `'purpose', g.purpose`.

**Response contract impact: additive only.** Every existing key in `source_expenses` is unchanged; this adds exactly one new key (`purpose`). `get_daily_project_report_page_v1`'s own signature and top-level JSON envelope are completely untouched by this amendment — it only ever calls through to `report_daily_project_rows_v1`, so the new field appears automatically in both the foreground (browser) and background (worker) paths, which read `source_expenses` from the exact same query.

This amendment is why a **separate, coordinated worker-side change was also required in the same integration** (see `Documentations MD/daily-report-remarks-column.md`) — the worker calls `report_daily_project_rows_v1` directly and has its own independent row-shaping code (`toGroup`/`finalize` in `supabase/functions/run-report-export-job/index.ts`) that also needed to read the new `purpose` field and join it into a `Remarks` cell. Migration 2 alone does not populate the Remarks column in either path; the worker code and the foreground `src/lib/buildDailyProjectExpenseReport.ts`/`dailyProjectReportPaging.ts` changes are equally required.

**Ambiguity Flagging amendment (2026-08-27, daily-report-data-recovery-render integration)**

Ported from `Preet-Patel/feature/daily-report-data-recovery-and-render`'s
`get_daily_report_project_name_ambiguity_v1` RPC, but folded into this
already-pending migration instead of shipped as a second, separately-callable
function:

1. A new `ambiguity` CTE (after `enriched`, before `resolved`) computes, per
   `project_id`, whether two or more DISTINCT non-blank `project_name_branch`
   values were actually submitted across sibling expenses.
2. `grouped` LEFT JOINs it and carries `project_name_ambiguous` (`bool_or`,
   constant per project id) into each group.
3. `items`' `jsonb_build_object(...)` adds `'project_name_ambiguous',
   COALESCE(r.project_name_ambiguous, false)` to every row.

**SOURCE MIGRATION REVIEWED:** `20260826100000_daily_report_dynamic_project_name.sql` (Preet-Patel/feature/daily-report-data-recovery-and-render, commit `ea66bf8`)
**INTEGRATION DISPOSITION:** Superseded / folded into `20260827160000_daily_project_report_shared_core.sql` (this migration). NOT a separately runnable migration in our lineage.

Rationale: the source migration's `dynamic:` field-mapping kind (a new
`_daily_report_parse_source_v1` value, requiring an explicit per-org config
opt-in) resolves a per-expense Project Name via a LATERAL join scoped by
`parent_template_id`/`parent_option_value`. This lineage's `project_name_branch`
fallback tier (already in this migration, pre-dating this integration)
achieves the same outcome unconditionally, for every organization, with no
config opt-in required, and this lineage additionally has a `defn`
(single-option branch-definition) fallback tier the source's `dynamic:`
mechanism entirely lacks. The source migration also contains one hardcoded,
org-specific statement —
`UPDATE public.organization_settings SET daily_expense_report_config = jsonb_set(...) WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344' ...` (MicroLink) — which is Category C (org-specific config change) under this integration's classification rules and was never eligible for porting regardless of the supersession finding above.

The ambiguity RPC's own early-exit logic (`get_daily_report_project_name_ambiguity_v1`
returns empty unless the org's config uses the `dynamic` kind) is COUPLED to
that same superseded design and was rewritten, not copied: this lineage's
`ambiguity` CTE runs unconditionally (matching that `project_name_branch`
itself runs unconditionally), computing the same "real submitted values
disagree" signal directly from `enriched`, with no config-kind gate at all.

**Why folded into this migration instead of a new migration / new RPC:**
a second, separately-callable RPC is exactly the shape of bug the Remarks
fix above exists to prevent — a worker or foreground caller can forget to
call it, or call it against a stale/different snapshot. Folding the signal
into `report_daily_project_rows_v1`'s own response means both callers read
it from the exact same query that already resolved `project_name`, with
nothing to forget. See the migration file's own AMENDED 2026-08-27 header
comment for the full reasoning, including why the DEFINITION's own
`jsonb_array_length(...) = 1` fallback condition is a different, unrelated,
pre-existing signal from this new ambiguity check.

**Response contract impact: additive only.** One new key (`project_name_ambiguous`) on every row object; nothing existing removed or renamed. `get_daily_project_report_page_v1`'s signature is unchanged.

**No new migration was needed for this module** (see also §5b below) — this is a case, invited by this integration's own task instructions, of proving a source migration is superseded rather than adding redundant code.

**Risk note**

This migration is **not destructive to stored expense data**, but it is **not purely additive at the SQL-object level** because it replaces the internals of an existing live report function. Both the Remarks and Ambiguity Flagging amendments are additive to the JSON response shape (new keys only, nothing removed or renamed).

Before this migration is allowed anywhere near the current shared/production database, verify it against:

1. an isolated/disposable database,
2. realistic Daily Project Report data,
3. current-main frontend behavior,
4. row counts,
5. project-name/project-ID resolution,
6. permissions,
7. pagination,
8. performance,
9. exact response-contract parity with the currently installed function,
10. **Remarks specifically**: comma-joined purposes, duplicates preserved, blanks skipped, source order preserved, parity between the value the browser renders and the value the downloaded CSV contains.

---

### Migration 3 — Claim Verification / Claim Approval / Detailed Expense server reports

**File**

`supabase/migrations/20260827170000_server_side_expense_reports.sql`

**Status**

**NOT APPLIED**

**Purpose**

Adds server-side row production and enqueue support for:

- Claim Verification
- Claim Approval
- Detailed Expense

It adds new helper/server functions and does not modify an existing table, column, RLS policy, or grant.

This migration depends on the report job infrastructure from Migration 1.

---

### Migration 4 — Report export history

**File**

`supabase/migrations/20260827180000_report_export_history.sql`

**Status**

**NOT APPLIED**

**Purpose**

Adds the report-history RPC:

- `list_report_export_jobs_v1`

The history includes information such as:

- filename
- status
- row count
- size
- generated date
- generated by
- expiry
- download availability

This migration is additive.

---

# 2a. PENDING DATA OPERATIONS — NOT SCHEMA MIGRATIONS

**NOT RUN. NOT APPLIED. REQUIRES OWNER APPROVAL.** These are not database
migrations and must never be treated as part of the migration chain above —
listed here only so nothing in this repository that touches real expense
data goes untracked.

| Package | Location | Status | What it does |
|---|---|---|---|
| Daily Project Report Project Name/ID recovery diagnostics | `supabase/diagnostics/daily-report-recovery/` | **NOT RUN. Layer 1/2/4 read-only; Layer 3's INSERT is commented out and requires manual owner uncommenting.** | Layer 1: reports resolution-tier/ambiguity health per organization (read-only). Layer 2: dry-run of what a Class A/B materialization write would insert (read-only). Layer 3: the guarded, transaction-wrapped, `NOT EXISTS`-guarded write itself — commented out, requires explicit owner review and manual execution. Layer 4: post-write verification (read-only). |

**Why this exists but is not a migration:** `Preet-Patel/feature/daily-report-data-recovery-and-render` performed 1,095 real, manual row-level writes into `expense_form_field_values` directly against MicroLink's backup database across three commits, entirely ad hoc — none of those writes exist as runnable SQL anywhere in that branch's history. This integration does not reproduce those specific writes (there is no code to reproduce); instead it provides a from-scratch, organization-parameterized, classification-guarded framework an owner can choose to run later, restricted to genuinely deterministic (Class A/B) cases only. See `supabase/diagnostics/daily-report-recovery/README.md` for the full classification table and safety properties.

**Do not run any file in that directory against any database, including a preview/isolated one, without first reading its own header comment and this section in full.**

---

# 3. Things that are still pending but are NOT migrations

After the four migrations are eventually validated and applied to a test/preview environment, the following operational steps are still required.

## A. Reload PostgREST schema cache

The newly created RPCs must become visible to PostgREST.

Do this only after the migration chain has completed successfully.

## B. Deploy the Edge Function

Pending Edge Function:

`supabase/functions/run-report-export-job`

Status:

**NOT DEPLOYED**

The frontend/job queue alone cannot generate files without the worker.

## C. Configure report-job maintenance

The integration introduces functions for job recovery/cleanup, including stale-job recovery and generated-file expiry.

The eventual deployment needs an appropriate scheduler/cron/operational mechanism.

Do not invent or enable one on the current production environment until the final deployment plan is reviewed.

## D. Perform end-to-end verification

After an isolated DB has all four migrations plus the worker:

- enqueue report
- worker claims report
- verify multi-page row production
- verify exact row count
- verify no duplicates
- verify private Storage upload
- verify completed job
- verify download
- verify history
- verify expiry behavior
- verify cross-organization isolation
- verify permission denials
- verify all four report types

---

# 4. Current testing rule

For the current frontend-testing phase:

## DO NOT

- apply any of these migrations
- modify the current shared database
- deploy `run-report-export-job`
- manually create its Storage bucket
- reload the schema cache for these RPCs
- run any data recovery
- run any production backfill
- merge this integration into `main`

## DO

- test the frontend branch
- run unit/component tests
- test report-page rendering
- test current Daily Project Report behavior
- verify no unrelated feature regression
- test mocks/synthetic data
- test error handling
- test missing-backend behavior
- compare against current `main`

---

# 5. Future Preet modules — not yet counted in this migration register

These branches are **not yet integrated into the cumulative current-main lineage**, so any migrations they contain are not part of the pending-run list above yet:

- `Preet-Patel/feature/admin-submit-expense-for-employee`

`Preet-Patel/feature/daily-report-remarks-column` **is now integrated** (as of `integration/preet-daily-report-remarks-column`, 2026-08-27) — see §5a below. It required no new migration file; it amended Migration 2 above.

`Preet-Patel/feature/daily-report-data-recovery-and-render` **is now integrated** (as of `integration/preet-daily-report-data-recovery-render`, 2026-08-27) — see §5b below. It required no new migration file; it amended Migration 2 above a second time.

`Preet-Patel/feature/balance-ledger-bulk-import` should not be blindly re-imported because current `main` already contains later balance-ledger / Tally / historical-balance work.

When each future module is ported, append any genuinely new required migrations to this register with:

- exact filename
- dependency order
- additive vs replacement classification
- existing-object impact
- rollback/recovery notes
- test status
- applied environments

---

## 5a. Daily Project Report Remarks Column — integrated 2026-08-27

**Branch:** `integration/preet-daily-report-remarks-column`, from `integration/preet-server-side-report-generation` @ `5a76739`.

**Migration impact:** none new. Amended the still-pending Migration 2 (`20260827160000_daily_project_report_shared_core.sql`) — see its section above for the exact two-line change and full rationale.

**Non-migration changes (frontend + worker code, no database involved):**

- `src/lib/buildDailyProjectExpenseReport.ts` — `DailyReportSourceExpense.purpose`, comma-join logic in `finalizeDailyReportGroups`, writes `row["Remarks"]`.
- `src/lib/dailyProjectReportPaging.ts` — `ServerSourceExpense.purpose` (optional — the currently-live, unmigrated RPC omits this key entirely; degrades to `null`/`""`, never throws), passthrough in `serverRowToGroup`.
- `supabase/functions/run-report-export-job/index.ts` — worker's own independent row-shaping (`Group.remarks`, `toGroup`, `finalize`) gains the identical comma-join logic. **This file is source-only in this integration; it is NOT deployed.**

**Why this needed a worker-side change at all**, given Migration 2 already emits `purpose` in `source_expenses` for both the foreground RPC and the worker's direct RPC call: the worker does not build its CSV from the RPC's `source_expenses` values verbatim — it re-shapes every row into its own `Group` type first via `toGroup()`, and that function had its own explicit field list that would have silently dropped `purpose` exactly the way the SQL's `enriched` CTE did, had it not been updated too. Documented at length, including the exact real-world incident this caused on the source branch (three rounds of a developer verifying only the foreground path while the actual downloaded CSV stayed blank), in `Documentations MD/daily-report-remarks-column.md`.

**Test status:** 41 new/updated tests across 5 files (foreground comma-join/duplicates/blanks/ordering, worker logic via a source-verified executable mirror — the real worker file cannot be imported into a JS test runner, see that doc for why — output parity between foreground and worker-mirror on identical input, page-boundary behavior at 1/250/251/1000/1001/5000 rows, graceful degradation when `purpose` is absent from the response entirely, and RFC 4180 CSV escaping of comma/quote/newline/Unicode remarks). Two consecutive full-suite runs, zero new failures.

**Applied environments:** NONE. Not applied to any database. Worker not deployed anywhere.

---

## 5b. Daily Report Data Recovery / Render — integrated 2026-08-27

**Branch:** `integration/preet-daily-report-data-recovery-render`, from `integration/preet-daily-report-remarks-column` @ `9627bd1`.

**Source branch:** `Preet-Patel/feature/daily-report-data-recovery-and-render` (4 commits: `18e4ee9` gap analysis, `ea66bf8` dynamic Project Name resolution + first controlled recovery, `69bd0c0` Project ID/Name full backfill + export ambiguity flagging, `703a556` full recovered/pending transaction detail — confirmed the branch tip, no later commits).

**Migration impact:** none new. Amended the still-pending Migration 2 a second time — see its "Ambiguity Flagging amendment" section above for the full CTE/response-contract detail and the SOURCE MIGRATION REVIEWED / INTEGRATION DISPOSITION block for `20260826100000_daily_report_dynamic_project_name.sql`.

**Per-commit classification:**

| Commit | Classification | Disposition |
|---|---|---|
| `18e4ee9` (gap analysis) | E — documentation/evidence only | Not portable as code; informed this integration's analysis only |
| `ea66bf8` (`dynamic:` resolution SQL) | A (generic resolver logic) mixed with C (hardcoded MicroLink `organization_settings` UPDATE) and D (463 undocumented-as-code DML rows) | A: superseded by this lineage's existing `project_name_branch`/`defn` fallback (see disposition block above). C: never ported. D: no runnable SQL exists to port; see §2a. |
| `69bd0c0` (ambiguity RPC + export markers + 626-row DML) | A (ambiguity signal, read-only, additive) + D (626 undocumented-as-code DML rows) | A: rewritten and folded into Migration 2 as `project_name_ambiguous` (early-exit gate rebuilt against this lineage's unconditional resolution, not the source's `dynamic`-kind gate). D: no runnable SQL exists to port; see §2a. |
| `703a556` (recovery detail, 6-row DML) | E — documentation/evidence only, plus D (6 undocumented-as-code DML rows) | Not portable as code; D has no runnable SQL to port; see §2a. |

**Data recovery deliberately NOT ported or executed:** the source branch's disclosed manual writes (463 + 626 + 6 = 1,095 rows into `expense_form_field_values` against MicroLink's backup database) have no corresponding SQL anywhere in that branch's history — they cannot be "run" from this repository at any point, by design or otherwise. See §2a and `supabase/diagnostics/daily-report-recovery/README.md` for the from-scratch, classification-guarded, organization-parameterized diagnostic package built for this integration instead, and why Class A/B recovery is already handled without any write at all by Migration 2's existing read-time fallback chain.

**Non-migration changes (frontend + worker code, no database involved):**

- `src/lib/dailyExpenseReportConfig.ts` — `DAILY_REPORT_NO_DATA_MARKER`, `DAILY_REPORT_AMBIGUOUS_NAME_MARKER`, `resolveProjectIdCell`, `resolveProjectNameCell`; `isDailyReportRowNeedsReview` updated to recognize both markers, not just a raw blank string.
- `src/lib/buildDailyProjectExpenseReport.ts` — `DailyReportGroup.projectNameAmbiguous` (optional), `finalizeDailyReportGroups` applies the marker functions when building `row["project id"]`/`row["project name"]`.
- `src/lib/dailyProjectReportPaging.ts` — `ServerReportRow.project_name_ambiguous` (optional, degrades to `false` on the currently-live unmigrated RPC), threaded through `serverRowToGroup`.
- `supabase/functions/run-report-export-job/index.ts` — worker's independent row-shaping (`Group.projectNameAmbiguous`, `toGroup`, `finalize`) gains a byte-for-byte port of the same two marker functions. **Source-only in this integration; NOT deployed.**

**Foreground/worker parity:** both paths read `project_name_ambiguous` from the exact same `report_daily_project_rows_v1` response (no second RPC call to forget, unlike the source branch's separate ambiguity RPC + export-time-only substitution design) and apply byte-for-byte identical marker functions. Covered by an executed parity test, the same pattern established for Remarks.

**1000+ row / pagination safety:** the `ambiguity` CTE is computed once, over the whole population, inside the same already-paginated `report_daily_project_rows_v1` call — it introduces no new query surface with different pagination semantics from the rest of that function (already covered by the 44 existing tests in `dailyProjectReportPaging.test.ts`, unmodified and still passing).

**Security:** no new RPC, no new grant, no new tenant-scope surface — the ambiguity signal lives entirely inside the already-`SECURITY DEFINER`, service-role-only `report_daily_project_rows_v1`, already revoked from `PUBLIC`/`anon`/`authenticated`. This was a deliberate design choice specifically to avoid introducing a second, separately-authorized function.

**Test status:** 29 new tests in `src/lib/__tests__/dailyReportProjectNameAmbiguity.test.ts` (marker resolution, `isDailyReportRowNeedsReview` marker detection, foreground/worker-mirror parity across 7 scenarios plus the legacy no-signal pipeline, RFC 4180 escaping of the ambiguous marker's embedded comma, and a mirror of the SQL `ambiguity` CTE's own COUNT(DISTINCT...) > 1 logic across 8 scenarios). All 5 pre-existing report test files (138 tests) re-run and pass unmodified — the marker change is additive and no existing test asserted on a raw blank string for these cells.

**Applied environments:** NONE. Not applied to any database. Worker not deployed anywhere. No data recovery, backfill, or Edge Function deployment was executed.

---

## 5c. Admin Submit Expense for Employee — integrated 2026-08-28

**Branch:** `integration/preet-admin-submit-expense-for-employee`, from `integration/preet-daily-report-data-recovery-render` @ `2f6edfc`.

**Source branch:** `Preet-Patel/feature/admin-submit-expense-for-employee` (16 total commits on the branch; only the last 6 — `91e6d13e`, `25ee6150`, `3aa8f66d`, `46ea9f9b`, `01d60835`, `225a3142` — belong to this feature; commits 1–10 are unrelated prior work, including the same server-side-report-generation feature already integrated as DOC-106, on the same physical branch lineage).

**Architecture decision (Phase 7):** the source used a two-step pattern — `admin_submit_expense_for_employee_v1` creates the expense in its own transaction, then a *separate* call to `replace_expense_form_field_values` saves custom fields, then an *optional third* call applies verify/approve. The source's own documentation discloses the resulting gap explicitly: a failed second call leaves an already-created, already-reviewer-notified expense with a permanently missing required field. This integration instead ships **`admin_submit_expense_for_employee_v2`**, a single SECURITY DEFINER function that performs authorization, expense creation, custom-field persistence (by calling the existing `replace_expense_form_field_values` inline, in the same transaction — not reimplemented), and an optional status transition (by calling the existing, unmodified `review_admin_verify_expense` / `review_approve_expense_v2`) all in one transaction. Any failure rolls back everything: no partial expense, no orphaned notification, no incomplete custom-field state. See the migration file's own header comment for the full rationale, including the one gap this does **not** close (required-field enforcement inside `replace_expense_form_field_values` is a pre-existing, system-wide limitation affecting the employee's own self-submission path too — not something introduced or fixable by this feature alone without a broader redesign).

**Idempotency (new, not present in the source):** `admin_submit_expense_idempotency` records one row per successfully committed submission, in the same transaction as the expense it maps to. A rolled-back attempt reserves no key, so a genuine retry after a real failure is never blocked; a retry after an actual success with the same key+payload replays the original result instead of creating a duplicate.

**Migration disposition per source commit:**

| Commit | Content | Classification | Disposition |
|---|---|---|---|
| `91e6d13e` | Origin `admin_submit_expense_for_employee_v1` (535-line migration): hierarchy-routing helper functions (9), the RPC itself, `created_by_admin_id` column, page/route/nav | A (routing helpers — independently re-verified line-by-line against this repo's own `src/lib/approvalHierarchy.ts`, not just trusted) + A (provenance column) | A: ported into Migration 5, reused as-is for routing. Two-step RPC architecture itself: superseded by the atomic V2 design above. |
| `25ee6150` | `admin_bulk_submit_expenses_v1` (bulk RPC, delegates to v1 per row) | A (bulk-loop pattern, per-row isolation, identity-resolution safety) | A: ported into Migration 5 as `admin_bulk_submit_expenses_v2`, delegating to the new atomic v2 RPC, with an added per-row `client_operation_id` requirement (idempotency; not present in the source) |
| `3aa8f66d` | Excel roster generator with live in-cell dropdowns (`exceljs` dependency), DD-MM-YYYY date format | D (already implemented differently) | DD-MM-YYYY parsing: ported (`parseDDMMYYYYToIso`). Live-Excel-dropdown generator: **not ported** — scoped to a CSV-only bulk template instead, avoiding a new runtime dependency for what is UI-authoring polish, not correctness or safety; see `src/lib/bulkExpenseImportParse.ts`'s header comment |
| `46ea9f9b` | Org-accurate custom fields: `orgExpenseFieldConfig.ts` (paginated org config fetch), custom-field wiring into the admin page and bulk parser | A (paginated config-fetch pattern, explicitly reusing the `.range()`-based drain established for DOC-097) | A: ported as `src/lib/orgExpenseFieldConfig.ts`, adapted to serve both the single-submit page and the CSV bulk parser |
| `01d60835` | Optional receipts, Submitted/Verified/Approved status choice, History tab, two RLS fixes (`audit_logs` org-scope, receipts Storage INSERT admin-bypass) | B (both RLS fixes) + A (status-choice UI pattern, History tab pattern) | `audit_logs` fix: **B, ported** as Migration 6 (independently confirmed this codebase has the identical gap). Storage INSERT fix: **E, superseded** — this codebase's current receipts bucket INSERT policy is already maximally permissive (`bucket_id = 'receipts' AND auth.uid() IS NOT NULL`, no ownership scoping at all), so the source's narrower "owner OR admin" policy would be a *regression*, not a fix; not ported, documented as a separate, pre-existing, out-of-scope-for-this-task over-permissioning concern (see Residual Risks in the dedicated doc). Status-choice/History UI: A, ported (folded into the atomic RPC's `p_status` parameter rather than a separate client-side call sequence) |
| `225a3142` | Inline receipt upload, Add Category button, `finalize-expense-receipts` ownership-bypass fix (tip) | B (Edge Function fix) + A (UI patterns) | Edge Function fix: **B, ported** directly into `supabase/functions/finalize-expense-receipts/index.ts` (confirmed this codebase has the identical strict-owner-only bug, inherited from the same pre-existing code, never fixed here before). UI patterns: A, ported |

**Response contract / grant hygiene improvement over the source:** the source's `admin_submit_expense_for_employee_v1`/`admin_bulk_submit_expenses_v1` migrations granted `EXECUTE` to `authenticated` but never explicitly revoked the PostgreSQL default `PUBLIC` `EXECUTE` grant a new function receives automatically. Migration 5 closes this for both new RPCs (explicit `REVOKE ALL ... FROM PUBLIC` / `FROM anon` before the `GRANT ... TO authenticated`), matching this codebase's own established convention (e.g. `report_daily_project_rows_v1`).

**Non-migration changes (frontend, no database involved):** `src/lib/adminSubmitExpense.ts` (service layer, error classification, receipt finalization), `src/lib/orgExpenseFieldConfig.ts` (new, paginated org config), `src/lib/bulkExpenseImportParse.ts` (new, CSV-only bulk parser/validator), `src/pages/AdminSubmitExpense.tsx` (new page), `src/components/SubmitStatusChoiceDialog.tsx`, `src/components/AdminExpenseHistoryTab.tsx` (server-paginated, 25/page), `src/components/BulkExpenseImportPanel.tsx` (new), `src/App.tsx` / `src/components/AppSidebar.tsx` (route + nav, admin-only), locale keys (en/hi/gu). `supabase/functions/finalize-expense-receipts/index.ts` — **source-only in this integration; NOT redeployed.**

**Test status:** 84 new tests across 5 files: SQL/Edge-Function structural-contract assertions (21, mirroring this codebase's established source-content-assertion pattern for untestable migrations), CSV parsing/validation including identity-ambiguity blocking (21), option-branch pagination at the required boundary row counts 0/1/499/500/501/999/1000/1001/1999/2000/2001/5000 (14), service-layer error classification/idempotency/bulk-chunking/receipt-evidence-integrity (23), and segregation-of-duties UI enforcement for the Approved status choice (5). All pre-existing tests (3774) re-run unmodified and pass; two consecutive full-suite runs both 3858 passed / 0 failed.

**Database changes made: NONE. Data recovery/backfill executed: NONE (none was ever in scope — this is a new feature, not a recovery task). Edge Function deployed: NONE (the finalize-expense-receipts fix is source-only).**

---

# 6. Intended eventual deployment sequence

This sequence is **for later**, after code/frontend QA and isolated DB testing.

1. Take a current DB backup/snapshot.
2. Verify current installed definitions of any RPC that will be replaced.
3. Apply `20260827150000_report_export_jobs.sql`.
4. Verify new table/functions/bucket/RLS.
5. Apply `20260827160000_daily_project_report_shared_core.sql`.
6. Verify current Daily Project Report still behaves identically where expected.
7. Apply `20260827170000_server_side_expense_reports.sql`.
8. Verify Claim Verification / Claim Approval / Detailed Expense permissions and pagination.
9. Apply `20260827180000_report_export_history.sql`.
10. Reload PostgREST schema cache.
11. Deploy `run-report-export-job`.
12. Test one report type at a time.
13. Verify permissions/cross-org isolation.
14. Verify large exports above 1,000 rows.
15. Only after preview/backup QA should Production rollout be considered.

---

# 7. Status tracker

> **2026-08-29 note (superseded by the 2026-08-29 Production activation, see below):** the checklist below originally described the pre-activation plan. Production activation is now COMPLETE — checkboxes updated to reflect what was actually applied/verified/deployed. Items still unchecked are genuinely outstanding (data recovery, `main` merge, a live cross-tenant request, and the `finalize-expense-receipts` timeout condition, which remains inconclusive rather than confirmed fixed).

- [x] Migration 1 — N/A, RETIRED: base object already live in Production, drift confirmed harmless
- [x] Migration 1 verified (2026-08-29)
- [x] Migration 2 as originally authored (Remarks + whole-population Ambiguity) — **ABANDONED**: applied to Production twice, rolled back both times (2+ minute hang; then a `plan_cache_mode` fix still measuring ~10.5-11.3s). See Migration 8 for what actually replaced it.
- [x] Existing Daily Project Report parity verified (exact match against pre-existing baseline, both on the throwaway restore and on Production)
- [x] Remarks column verified on real data: comma-join, duplicates preserved, blanks skipped, order preserved (downloaded real Production CSV inspected directly)
- [x] Remarks parity verified between the foreground code path and worker-generated CSV download (both call the same core function; downloaded CSV confirmed real remark text present)
- [x] Project Name ambiguity flag verified on real data via the new batch RPC (not the abandoned whole-population design): downloaded real Daily Project Report CSV shows both the ambiguous marker (3 occurrences) and the no-data marker (59 occurrences) rendering correctly
- [x] "N/A - no data on record" vs "Ambiguous - multiple names on record, unresolved" parity verified in the real downloaded Production CSV
- [ ] Daily Project Report recovery diagnostics (`supabase/diagnostics/daily-report-recovery/`) — still NOT run, per standing instruction; no Layer 3 write considered
- [x] Migration 3 — RETIRED, already live and body-identical, grant delta addressed by Migration 7
- [x] Migration 3 verified
- [x] Migration 4 — RETIRED, already live and confirmed semantically identical
- [x] Report history verified (all four report types, real jobs, `list_report_export_jobs_v1`)
- [x] PostgREST cache reloaded (confirmed via reload log: 73 relations, 248 functions)
- [x] Worker deployed to PesoWise Production Edge Functions container (2026-08-29)
- [x] Daily Project Report E2E passed (real worker run, 5,078 rows, Remarks + Ambiguity confirmed in downloaded CSV)
- [x] Claim Verification E2E passed (real worker run, 1,923 rows)
- [x] Claim Approval E2E passed (real worker run, 12,601 rows — exceeds 1,000)
- [x] Detailed Expense E2E passed (real worker run, 12,601 rows — exceeds 1,000)
- [ ] Cross-org security test — RPC-level grant/authorization checks done (anon denied, org-scoped RLS confirmed); a live cross-tenant request was not performed this session
- [x] Large-report test passed (>1,000 rows, twice, via the real worker)
- [x] Backup environment QA passed (throwaway restore of real Production data used for all heavy pre-deployment testing)
- [x] Migration 5 (Admin Submit) applied to Production, 2026-08-29, dependency signatures rechecked immediately before apply
- [x] Migration 7 (grant hardening) applied to Production, 2026-08-29
- [x] Migration 8 (`20260829120000_daily_report_remarks_and_batch_ambiguity.sql`, replacing Migration 2's ambiguity design) applied to Production, 2026-08-29
- [x] `finalize-expense-receipts` redeployed with admin-authorization fix, prior version preserved as a named rollback
- [ ] `finalize-expense-receipts` execution-timeout condition — inspected post-redeploy, not conclusively confirmed still occurring from server logs alone; remains open
- [ ] Data recovery/backfill — NOT run
- [ ] `main` merge — NOT done, pending owner's own frontend QA
- [ ] Production approval given
- [ ] Production migrations applied
- [ ] Production worker deployed
- [ ] Production smoke test passed
- [ ] Migration 5 (`admin_submit_expense_for_employee_v2` / `admin_bulk_submit_expenses_v2`) applied to isolated test DB
- [ ] Migration 6 (`org_scoped_audit_logs_select`) applied to isolated test DB
- [ ] Cross-org employee id submission blocked, verified live
- [ ] Segregation-of-duties (same admin creates + approves) audit action verified live
- [ ] Atomic rollback verified live: a deliberately invalid custom-field value produces zero rows in `expenses`, `audit_logs`, and `notifications`
- [ ] Idempotency verified live: identical retry (same key + payload) returns the original expense, never a duplicate
- [ ] `finalize-expense-receipts` redeployed with the admin-bypass fix, verified an admin can finalize a delegated receipt live
- [ ] Option-branch pagination verified against a real >1,000-row organization

---

# 9. Preet branch closure — final disposition

| Source branch | Disposition |
|---|---|
| `Preet-Patel/feature/server-side-report-generation` | **INTEGRATED** — see DOC-106, `integration/preet-server-side-report-generation` |
| `Preet-Patel/feature/daily-report-remarks-column` | **INTEGRATED** — see DOC-107, `integration/preet-daily-report-remarks-column` |
| `Preet-Patel/feature/daily-report-data-recovery-and-render` | **INTEGRATED** — see DOC-108, `integration/preet-daily-report-data-recovery-render` |
| `Preet-Patel/feature/admin-submit-expense-for-employee` | **INTEGRATED BY THIS BRANCH** — see DOC-109, `integration/preet-admin-submit-expense-for-employee` |
| `Preet-Patel/feature/balance-ledger-bulk-import` | **SUPERSEDED / NO INTEGRATION REQUIRED.** Current `main`/integration balance architecture (Historical Balance Anchors V2, `balance_apply_import_v2`, Tally Group Summary direct import — DOC-103/104/105) already contains equivalent, more thoroughly hardened functionality, built and shipped independently on `feature/bulk-balance-import-ledger` before this Preet-integration effort began. Do not port. |

After this task there are **zero unclassified Preet feature branches.**
