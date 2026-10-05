# Daily Project Report — Data Recovery / Render (Project Name Ambiguity)

**Doc ID:** DOC-108
**Status:** in progress
**Last updated:** 2026-08-27
**Owner / area:** Reports (`/reports`, Daily Project Report tab)

---

## 1) Summary

Integrates ONLY `Preet-Patel/feature/daily-report-data-recovery-and-render` onto `integration/preet-daily-report-remarks-column` (DOC-107), producing `integration/preet-daily-report-data-recovery-render`. The source branch's real contribution — after auditing its full history, not just its tip — is a Project Name ambiguity signal for the Daily Project Report export: distinguishing "nobody has ever recorded a name for this project" from "this project has been given more than one conflicting name, and picking any one of them would fabricate a fact." That signal is ported here, folded into the already-pending shared SQL core rather than shipped as a second, separately-callable RPC. The source branch's `dynamic:` Project Name resolution mechanism was found to be **already fully superseded** by this lineage's existing fallback chain and was not ported. The source branch's real, manual, ad hoc data-recovery writes against MicroLink's backup database (1,095 rows across three commits) were **not** ported or executed — none exist as runnable SQL anywhere in that branch's history, so there was nothing to "disable and not run"; a from-scratch, classification-guarded diagnostic package was built instead (§7). No database of any kind has been touched, no migration applied, no Edge Function deployed.

## 2) Problem / requirement

Task: integrate ONLY this one Preet feature, onto the current authoritative integration lineage (`main` → DOC-106 → DOC-107 → this), not `main` and not the raw Preet branch directly. Read the source branch's ENTIRE relevant history (four commits: `18e4ee9`, `ea66bf8`, `69bd0c0`, `703a556`), classify every change, and — critically — prove (not assume) whether the source's Project Name resolution mechanism is already superseded by, partially superseded by, or genuinely missing from this lineage's own `report_daily_project_rows_v1` (which independently gained its own three-tier Project Name fallback chain during DOC-106/107, for unrelated reasons — a real defect fix, not a port of this source branch). Never automatically write inferred or majority-vote data as if it were original persisted truth; never reintroduce an older migration timestamp just because that was Preet's original filename; never let the worker and foreground drift on ambiguity semantics the way they drifted on Remarks (DOC-107).

## 3) Source branch audit

**Branch tip confirmed:** `703a556` (no later commits exist).

| Commit | Content | Classification | Disposition |
|---|---|---|---|
| `18e4ee9` | Gap-analysis documentation (DOC-113 equivalent on the source repo) | E — documentation/evidence only | Informed this audit; not portable as code |
| `ea66bf8` | New `20260826100000_daily_report_dynamic_project_name.sql`: adds a `dynamic:` field-source kind to `_daily_report_parse_source_v1`; a monolithic (pre-shared-core) `get_daily_project_report_page_v1` resolving Project Name via a LATERAL join scoped to `parent_template_id`/`parent_option_value`; a hardcoded `UPDATE organization_settings ... WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'` (MicroLink); plus 463 real data-recovery writes into `expense_form_field_values`, described in the commit message only, no SQL | A (resolver logic) + C (org-specific config UPDATE) + D (undocumented-as-code DML) | A: **superseded**, see §4. C: never portable, regardless of the supersession finding. D: no runnable SQL exists to port — see §7. |
| `69bd0c0` | New `20260826110000_daily_report_project_name_ambiguity_rpc.sql` (`get_daily_report_project_name_ambiguity_v1`, read-only, `COUNT(DISTINCT ...) > 1` per project id, gated on the `dynamic` config kind); frontend export-time marker substitution (`exportDailyProjectExpenseReport.ts`'s `NO_DATA_MARKER`/`AMBIGUOUS_MARKER`, `dailyExpenseReportConfig.ts`'s `fetchDailyReportProjectNameAmbiguity`, `Reports.tsx`'s export made async); plus 626 more real data-recovery writes, described in the commit message only, no SQL | A (ambiguity signal + marker strings, both generic/reusable) + D (undocumented-as-code DML) | A: **ported**, rewritten — see §5. D: no runnable SQL exists to port — see §7. |
| `703a556` | Full recovered/pending transaction detail (documentation); 6 more real data-recovery writes, described in the commit message only, no SQL | E (documentation) + D (undocumented-as-code DML) | Not portable as code; D — see §7. |

No commit in this branch's history is Category B (a portable, org-agnostic schema/RPC migration on its own, cleanly separable from A/C/D) or Category F (superseded by something even later in this same branch) or Category G (unsafe/no-longer-applicable) — every commit fell into A, C, D, or E.

## 4) Critical overlap audit — Project Name resolution (Phase 4)

**Question:** is the source's `dynamic:` Project Name mechanism (A) already completely superseded by this lineage's existing fallback chain, (B) partially superseded, or (C) does it contain genuinely missing functionality?

**Answer: (A) completely superseded.**

This lineage's `report_daily_project_rows_v1` (inside the still-pending `20260827160000_daily_project_report_shared_core.sql`, added during DOC-106/107 to fix a real, independently-discovered defect — blank Project Name on nested-sub-option rows, unrelated to this source branch) already resolves Project Name via three tiers:

1. `project_name_configured` — the org's explicitly configured field mapping.
2. `project_name_branch` — the project_name value actually **submitted on that specific expense** (an UNCONDITIONAL LATERAL join on `expense_form_field_values`/`expense_form_field_option_branches` by `field_key = 'project_name'`, no filter on `parent_option_value`/`parent_template_id`).
3. `defn` — the project's branch **definition**, only when it has exactly one possible option (a genuinely deterministic 1:1 default).

The source's `dynamic:` mechanism resolves Project Name via a LATERAL join requiring `parent_template_id = <the org's configured project-id template>` AND `parent_option_value = <this row's own resolved project_id>` AND `field_key = 'project_name'` — but **only when the org has explicitly opted in** by setting `fieldMappings.projectName` to a `dynamic:...` value. Comparing the two mechanisms directly:

- Tier 2 above (`project_name_branch`) achieves the identical practical outcome — "find the project_name value this specific expense actually submitted" — **without requiring any per-org config opt-in**, because `expense_form_field_values.branch_field_id` already uniquely identifies one specific branch node tied to whichever project was chosen at submission time. A given expense can only ever have one submitted project_name-type value, so omitting the `parent_option_value`/`parent_template_id` filter introduces no cross-project ambiguity: the join is already scoped correctly by construction, not by the extra predicate the source adds.
- Tier 3 above (`defn`) has **no equivalent at all** in the source's `dynamic:` mechanism — the source never falls back to a branch definition's single option; it either resolves via the submitted value or via nothing (blank).
- Tier 2 runs **unconditionally, for every organization**, not only for orgs that set `fieldMappings.projectName` to a `dynamic:...` value. An org using this lineage gets the recovery automatically; an org using the source's mechanism gets it only after manually opting in per-org (exactly the kind of manual, per-org configuration step `ea66bf8`'s hardcoded MicroLink `UPDATE organization_settings` statement exists to perform).

Proof, not assumption: `src/lib/__tests__/dailyReportProjectNameAmbiguity.test.ts` exercises the actual, imported `resolveProjectIdCell`/`resolveProjectNameCell`/`isDailyReportRowNeedsReview` functions and a byte-for-byte mirror of the SQL's ambiguity signal; the SQL fallback chain itself (tiers 1–3) is pre-existing, unmodified by this integration, and was already covered by this lineage's DOC-106/107 test suite (138 tests, re-run unmodified and still passing — see §9). No new test was needed to re-prove tiers 1–3 are correct, since this integration did not touch them; what needed proof was specifically that tier 2+3 together are a strict superset of the source's `dynamic:` mechanism, which is a structural/logical argument (every case the source's join can match, tier 2's less-restrictive join also matches, plus tier 3 covers cases the source has no answer for at all) rather than a runtime behavior difference that a test could additionally distinguish without a live database.

**SOURCE MIGRATION REVIEWED:** `20260826100000_daily_report_dynamic_project_name.sql`
**INTEGRATION DISPOSITION:** Superseded / folded into `20260827160000_daily_project_report_shared_core.sql`. NOT a separately runnable migration in this lineage. The one hardcoded, org-specific statement in that file (the MicroLink `organization_settings` UPDATE) is Category C and was never eligible for porting under any disposition.

## 5) Ambiguity flagging (Phase 6)

**Question:** should `get_daily_report_project_name_ambiguity_v1` be ported as a new migration, folded into the existing shared core, or excluded?

**Answer: folded into the existing shared core (Migration 2, amended a second time). No new migration file.**

The source RPC's own early-exit logic (`RETURNS empty unless the org's config uses the 'dynamic' kind`) is coupled to the exact mechanism just found to be superseded — porting it unmodified would mean it silently never fires under this lineage's actual (unconditional, non-opt-in) resolution design. Rather than rewrite it as a second, separately-callable function — which reintroduces precisely the "a caller can forget to call the second RPC" shape of bug that caused the Remarks foreground/worker drift (DOC-107 §4) — the same signal (`COUNT(DISTINCT ...) > 1` of real submitted project_name values per project id) is computed once, inside `report_daily_project_rows_v1` itself, from the same `enriched` rows already scanned for Project Name resolution, and returned as a plain `project_name_ambiguous` boolean on every row. Both `get_daily_project_report_page_v1` and the worker's direct call read it from the exact same query — there is nothing for either caller to remember to do differently. See `supabase/migrations/20260827160000_daily_project_report_shared_core.sql`'s "AMENDED 2026-08-27 (preet-daily-report-data-recovery-render integration)" header comment and `Documentations MD/PENDING_MIGRATIONS_PREET_INTEGRATION.md`'s Migration 2 section for the full SQL/rationale.

**Security impact of this design choice:** zero new grant surface. No new RPC, no new `REVOKE`/`GRANT` statements, no new tenant-scope question — the signal lives entirely inside the already-`SECURITY DEFINER`, service-role-only `report_daily_project_rows_v1`, already revoked from `PUBLIC`/`anon`/`authenticated`.

## 6) Rendering — the two marker strings

Presentation-only, never written to the database, applied at row-shaping time (not export time, unlike the source branch's design):

- **`"N/A - no data on record"`** — a blank project id, or a blank project name with no ambiguity signal.
- **`"Ambiguous - multiple names on record, unresolved"`** — a blank project name where `project_name_ambiguous` is true. A row with its own resolved name is never itself ambiguous, even if sibling expenses under the same project id disagree.

`src/lib/dailyExpenseReportConfig.ts` gained the two marker constants and `resolveProjectIdCell`/`resolveProjectNameCell`. `isDailyReportRowNeedsReview` was updated to recognize both markers, not just a raw blank string — otherwise the existing "needs review" UI highlighting in `Reports.tsx` would have silently stopped catching these rows the moment the markers were wired in (a row that used to read `""` and get flagged now reads a non-empty marker string).

## 7) Files changed

```
supabase/migrations/20260827160000_daily_project_report_shared_core.sql   (amended again, not a new file — see §5)
src/lib/dailyExpenseReportConfig.ts
src/lib/buildDailyProjectExpenseReport.ts
src/lib/dailyProjectReportPaging.ts
supabase/functions/run-report-export-job/index.ts   (source-only, NOT deployed)
src/lib/__tests__/dailyReportProjectNameAmbiguity.test.ts   (new)
supabase/diagnostics/daily-report-recovery/README.md   (new)
supabase/diagnostics/daily-report-recovery/01_read_only_analysis.sql   (new)
supabase/diagnostics/daily-report-recovery/02_prepared_materialization_dry_run.sql   (new)
supabase/diagnostics/daily-report-recovery/03_prepared_write.sql   (new)
supabase/diagnostics/daily-report-recovery/04_post_write_verification.sql   (new)
Documentations MD/PENDING_MIGRATIONS_PREET_INTEGRATION.md   (updated)
Documentations MD/index.md   (updated)
```

## 8) Data recovery — deliberately not ported or executed (Phase 7/8)

The source branch's disclosed manual writes (463 + 626 + 6 = 1,095 rows into `expense_form_field_values` against MicroLink's backup database, explicitly never applied to Production per every commit message) exist **only as prose/tables in commit messages** — no migration, no script, no SQL code block anywhere in that branch's history. There is therefore no executable code to "port but disable"; nothing from that branch was executed, and nothing could have been even if this integration had wanted to reproduce it verbatim.

Instead, `supabase/diagnostics/daily-report-recovery/` (NOT RUN, NOT APPLIED) provides a from-scratch, organization-parameterized framework restricted to genuinely deterministic cases:

| Class | Meaning | Automated? |
|---|---|---|
| A | Exactly one real value recorded elsewhere for the same Project Unique ID | Already resolved at **read time** by tier 2/3 in §4 — no write needed for correct report output; optionally materializable (Layer 2/3) |
| B | Exactly one valid configured branch option | Already resolved at **read time** by tier 3 in §4 — no write needed; optionally materializable |
| C | Unanimous batch-sibling inference | **Never automated.** Inference, not fact. |
| D | Same-employee nearest-neighbor inference | **Never automated.** Inference even at high confidence. |
| E | Majority/ambiguous signal | **Never automated.** This is exactly what the ambiguity marker exists to surface, not paper over. |
| F | No signal at all | **Never automated.** Renders as "N/A - no data on record". |

Four layers, all read-only except the fourth-of-four gated, commented-out `INSERT`:

1. `01_read_only_analysis.sql` — resolution-tier breakdown + ambiguous-project-id report, per organization.
2. `02_prepared_materialization_dry_run.sql` — shows exactly which Class A/B rows could additionally be persisted (optimization only; the report is already correct without this).
3. `03_prepared_write.sql` — the guarded, transaction-wrapped, `NOT EXISTS`-guarded `INSERT`, commented out, requires manual owner review and manual uncommenting.
4. `04_post_write_verification.sql` — post-write row-count/cross-org/no-inference verification.

See that directory's `README.md` for the full safety-property list. No file in that directory has been run against any database in this session.

## 9) Tests

`src/lib/__tests__/dailyReportProjectNameAmbiguity.test.ts` (new, 29 tests):

- `resolveProjectIdCell`/`resolveProjectNameCell` (real, imported) across resolved/blank/ambiguous combinations.
- `isDailyReportRowNeedsReview` recognizing both markers, not just a raw blank string.
- Foreground (`finalizeDailyReportGroups`, real, imported) vs. a byte-for-byte port of the worker's mirrored marker functions, across 7 scenarios plus the legacy no-signal pipeline — the same output-parity pattern DOC-107 established for Remarks, guarding against the identical class of foreground/worker drift.
- RFC 4180 escaping of the ambiguous marker's embedded comma (`"Ambiguous - multiple names on record, unresolved"` contains a literal `,`).
- A mirror of the SQL `ambiguity` CTE's `COUNT(DISTINCT ...) > 1` logic across 8 scenarios (single name, two distinct names, blank names excluded, zero signal, cross-project independence, blank project id, 3+ names, multi-tenant scoping note).

All 5 pre-existing report test files (138 tests: `reportExportWorker`, `serverSideReportGeneration`, `dailyReportRemarksWorkerLogic`, `buildDailyProjectExpenseReport`, `dailyProjectReportPaging`) re-run unmodified and pass — the marker change is additive at the cell-value level and no existing test asserted a raw blank string for `project id`/`project name`.

1000+ row / pagination safety: the new `ambiguity` CTE is computed once, over the whole population, inside the same already-paginated `report_daily_project_rows_v1` call. It introduces no new query surface with different pagination semantics from the rest of that function — the existing 44 tests in `dailyProjectReportPaging.test.ts` already cover page-boundary behavior for this function and needed no changes.

## 10) Database / deployment status

**NONE. No migration applied. No data recovery or backfill executed. No Edge Function deployed. Production and the backup database were not touched or contacted in any way.**

## 11) Residual risks / manual QA still required

- The `ambiguity` CTE's practical performance impact on organizations with very large `expense_form_field_values` tables has not been measured against a real database (none available this session) — should be checked alongside the rest of Migration 2's own pre-existing performance review before this migration is ever applied anywhere.
- `03_prepared_write.sql`'s optional materialization has never been executed, dry-run or otherwise, against real data — an owner choosing to use it should run Layers 1 and 2 against a real isolated/preview snapshot first and manually review every candidate row before ever uncommenting Layer 3.
- The `defn` fallback tier's pre-existing (not modified by this integration) tie-break rule — `ORDER BY retired_at NULLS FIRST` with no `WHERE retired_at IS NULL` filter — means a fully-retired branch's single option can still be used as a fallback when no active alternative exists for that project id. This was reviewed as part of this integration's Phase 4 comparison but is pre-existing DOC-106/107 behavior, out of this task's scope to alter; flagged here for a future, separately-scoped review if the owner considers it a correctness question.

---

## Revision log

| Date | Change | By |
|---|---|---|
| 2026-08-27 | Initial version. Integrated ONLY `Preet-Patel/feature/daily-report-data-recovery-and-render` onto `integration/preet-daily-report-remarks-column`. Project Name `dynamic:` resolution found superseded, not ported. Ambiguity signal ported, folded into the existing shared core. Data-recovery writes not ported (no runnable SQL exists in source history) or executed; from-scratch diagnostic package built instead. 29 new tests. Not merged, no database touched. | Claude Code |
