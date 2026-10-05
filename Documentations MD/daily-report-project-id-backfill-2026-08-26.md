# Project ID / Project Name — full backfill + export flagging — 2026-08-26

**Doc ID:** DOC-141 (formerly DOC-113 second follow-up / DOC-114) (renumbered on the 2026-10-05 upstream sync — see DOC-143; the pre-sync `peso-bckup` index gave this a different ID than upstream's independently-numbered catalog)
**Status:** deployed to backup instance. NOT applied to Production.
**Scope:** MicroLink organization, **all expense statuses** (not approved-only — this round covers Batch Review, which happens before approval).

## Context

After the first DOC-113 fix (Daily Project Report's Project Name resolution, 390+73 rows), the user pointed out a related but distinct gap in the **Batch Review** UI: the separate "Project ID" field (short numeric codes like `4182`, a different field from both "Project Unique ID" and "Project Name") is frequently left blank by employees, even though it is marked required on the submission form. They asked whether restoration is possible, given their belief that each Project Unique ID has exactly one Project ID and one Project Name by the app's own design.

## Investigation before writing anything

Read `Documentations MD/option-branches-data-loss-fix.md` (DOC-045/047) first — this table (`expense_form_field_option_branches`) has a documented history of real accidental data-loss incidents (now fixed via an atomic RPC, DOC-047). Ran the project's own read-only health-check queries (`docs/sql/project-branch-integrity-check.sql`) against the live backup database before touching anything:

- Confirmed DOC-047's atomic-save migration **is** applied here (`retired_at`/`retired_by`/`retired_reason` columns present).
- **4 Project Unique IDs** (`201904M524`, `201904M530`, `202510M466`, `202604M25`) have a `project_id` branch definition but **no `project_name` branch definition at all** — not a missing value, a missing *field*. These are old (2019-vintage) projects, already retired from the template's active options list (orphaned, not currently selectable) — genuinely unfixable without recreating the branch definition itself, which is a different, more invasive kind of change than filling in a value. Left untouched.
- **`197001M3`** has two *legitimate* values in its own admin-configured options list — Project ID `["326","506"]` and Project Name `["Training","Support"]` — both actually used by a meaningful number of real expenses (26/7 and 24/9). This is architected ambiguity, not a data-entry mistake. Confirmed unchanged from the earlier finding; still left flagged, not guessed.
- The reference "ground truth" source file mentioned in that doc (`Project_Name_list_Latest.csv`, 408 rows) is not present in this repository — it was a one-time manual upload, now gone. The statistical inference method (exactly one distinct value ever recorded per Project Unique ID) used below is the best available signal, not a fallback from a better option.

## What was written

Three additional writes, all idempotent (`NOT EXISTS` guarded) and each verified with a live dry-run count matching the actual `INSERT` count before committing:

1. **498 "Project ID" values** (the short-code field, distinct from Project Unique ID) — deterministic, same safety rule as Project Name (exactly one distinct value ever recorded for that Project Unique ID; excludes `197001M3`). All statuses, not approved-only.
2. **16 "Project Unique ID" values** — a new method, per the user's own suggested logic: within a batch (`expenses.batch_id`), if every sibling line that *does* have a Project Unique ID agrees unanimously, and one or more lines in that same batch are blank, fill the blank lines with that same value. Skipped: any batch where siblings genuinely disagree (11 such batches found, but all had zero blank lines, so nothing to resolve there anyway), and any batch where every line is blank (19 such batches — no signal to infer from, left blank).
3. **112 additional "Project Name" values** — the original DOC-113 fix only covered approved expenses (the Daily Project Report's scope); this extends the same deterministic method to every status, including the 16 newly-resolved expenses from step 2 above, whose Project ID and Project Name cascaded automatically once their Project Unique ID became known.

**626 rows this round**, on top of the 463 from the original DOC-113 fix — **1,089 total** `expense_form_field_values` rows added for this feature.

### Verification against the user's own screenshot

The batch shown in the user's example (Yavatmal, employee Virendrasinh Mahida, 5 lines, ₹1,200 total, batch `3adbe094-c8a1-4020-9027-c53f3fed3d59`) was one of the 12 batches fixed by step 2. Queried it directly after the write: all 5 lines now show Project Unique ID `199601M1`, Project ID `4182`, Project Name `At Office` — including the previously-blank line (`#01015`, Hotel/Guest House) that the screenshot showed as `—`.

### Frontend rendering — confirmed, no code change needed

`BatchExpenseReviewPanel.tsx` (via `fetchBatchExpenseCustomFields` in `src/lib/batchExpenseReview.ts`) resolves and labels dynamic columns purely by the `name` column on `expense_form_field_templates`/`expense_form_field_option_branches` — not by `field_key`, not by any hardcoded id. Since the branches this backfill writes into are the same, already-existing, correctly-named ("Project ID" / "Project Name") branch rows, the UI picks up the new data automatically. No frontend change was required for Batch Review itself.

## Export flagging (the other explicit ask)

The Daily Project Report's CSV/Excel export previously showed a genuinely-blank cell no differently from any other blank — no way to tell "checked, no data exists" from "not looked at." Fixed:

- New RPC `get_daily_report_project_name_ambiguity_v1` (migration `20260826110000_daily_report_project_name_ambiguity_rpc.sql`) — returns, live and computed fresh every call, the small set of Project Unique IDs with more than one distinct Project Name on record. Kept as its own RPC rather than folded into the main paginated report envelope, since it's an unrelated, cheap, org-wide fact that doesn't need to ride along with pagination/schema versioning.
- `src/lib/exportDailyProjectExpenseReport.ts` now writes `N/A - no data on record` into a genuinely-blank "project id" or "project name" cell, or `Ambiguous - multiple names on record, unresolved` for the specific case of a known-ambiguous Project ID — instead of leaving the cell empty. Column layout is completely unchanged (no new column added), per explicit instruction, since the existing header order may be expected by an external process.
- Wired through `Reports.tsx`'s `exportDailyProjectReport`, which now fetches the ambiguity set before building the file. Both CSV and XLSX share the same builder, so both are covered identically.
- 5 new unit tests in `exportDailyProjectExpenseReport.test.ts`, all passing; zero new TypeScript errors (verified against the correct `tsconfig.app.json`, not the empty-fileset `tsconfig.json` used earlier this session by mistake); clean production build.

## What's still genuinely unresolved

| Category | Count | Why |
|---|---|---|
| Project Unique ID, no value anywhere | 60 | Never selected, no batch-sibling signal available |
| Project ID, given Project Unique ID known | 8 | The 1 ambiguous project (`197001M3`) plus the 4 orphaned/incomplete branch definitions |
| Project Name, given Project Unique ID known | 8 | Same 5 projects |

These remain genuinely blank in the app and will show the new marker text in exports — no data was fabricated for them.

## Verification checklist

- [x] Every write dry-run counted before executing; actual `INSERT` count matched the dry-run exactly in all 3 cases (498, 16, 112)
- [x] `expense_form_field_values` row count before/after each write matches the insert count exactly
- [x] Cross-checked against the user's own screenshot batch — confirmed live
- [x] Confirmed frontend (`BatchExpenseReviewPanel`) requires no code change — resolution is name-based, already correct
- [x] `tsc --noEmit -p tsconfig.app.json`: 18 errors in touched files, identical set to the pre-existing baseline — zero new
- [x] `npx vitest run exportDailyProjectExpenseReport.test.ts`: 7/7 pass
- [x] `npm run build:keep-maps`: clean
- [x] `npm run security:secrets`: clean

Backup instance only (`pesowise-backup-supabase.unimisk.com`). NOT applied to Production.
