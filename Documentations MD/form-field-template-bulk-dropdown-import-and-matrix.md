# Form Field Template — Bulk Options + Dependent Dropdown Import + Excel + Paste + Matrix UX

**Doc ID:** DOC-094
**Status:** READY FOR MERGE REVIEW (debug branch only — not merged to main/dev; independent release-readiness audit complete, all confirmed blockers fixed and regression-tested)
**Last updated:** 2026-08-14
**Owner / area:** Form Builder — Form Field Template Editor (Parent Options, Dependent Fields, Matrix)

---

## 1) Summary

Replaces the old "split on commas/newlines" bulk-paste for parent options, and wires up a dependent-table (sibling-column) importer that previously existed in `cascadingOptionsCsv.ts` but was never reachable from any UI. One shared `DropdownBulkImportDialog` now handles paste and file upload (CSV/TSV/TXT/XLSX/XLS) for both flat option lists and dependent tables, with format auto-detection, header-to-existing-field matching, an analysis/preview step, and explicit Merge (default) or Replace (confirmed) application into the editor's local draft. The Matrix view can now build its columns directly from existing dependent fields, so it's usable immediately after an import without requiring a saved preset first.

---

## 2) Problem / requirement

The scalable Form Field Template editor already had Parent Options, Dependent Fields, a List view, a Matrix view, reusable presets, `DraftOptionBranch[]`, dirty-state tracking, and atomic persistence via `saveOptionBranchConfigurationAtomically`. What it lacked:

- A real bulk-paste for parent options (the old `parseBulkOptionValues` just split on commas/newlines — no CSV/TSV awareness, no Excel).
- Any UI path to the dependent-table CSV model already implemented in `cascadingOptionsCsv.ts` (`Project Unique ID,Project ID,Project Name` → one parent with N sibling dependent fields) — the parser existed but nothing called it.
- Excel support at all.
- A quoted-CSV-cell parser that survives an embedded line break inside a cell (the old parser split on `\r?\n` before quote-handling, so a quoted multi-line cell broke the row structure).
- A way to review hundreds of options/choices before they became part of the draft, or to merge an import into an already-populated template without silently destroying existing metadata or manually configured nested branches.

---

## 3) Solution

**Shared pure engine** (`src/lib/formBuilder/dropdownBulkImport.ts`): a real CSV/TSV state-machine parser (`parseDelimitedText`) that handles quoted cells, escaped quotes, CRLF/LF, embedded newlines inside quotes, and a UTF-8 BOM — used instead of a naive line-split. Format detection (`detectImportFormat`) treats a single row as a flat option list regardless of column count, and 2+ rows with 2+ columns as a dependent table with column 1 as the parent and columns 2+ as sibling dependent fields (never the old parent→child→child chained-path interpretation). Header matching (`matchHeaderToExistingField`) tries exact `field_key`, a normalized slug, and case-insensitive name against existing root dependent fields, and reports genuine ambiguity (multiple distinct matches) instead of guessing. `analyzeFlatImport`/`analyzeDependentImport` produce preview stats and a typed `ImportConflict[]` split into blocking vs. non-blocking. `applyFlatImport`/`applyDependentImport` are the only functions that touch `options[]`/`DraftOptionBranch[]`, and they return new arrays — Merge preserves existing option casing, existing field metadata (`localId`, `dbId`, `field_type`, `name`, `field_key`, `required`, `placeholder`, `help_text`, `display_order`) and all nested/descendant branches; Replace is scoped to only the `(parent_option, field_key)` pairs actually present in the import.

**Excel** (`src/lib/formBuilder/dropdownBulkImportExcel.ts`): dynamically imports the already-installed `xlsx` package (no new dependency) so it never loads for non-Excel imports; lists sheet names for a picker and converts the chosen sheet to a normalized `string[][]` via `sheet_to_json({header: 1, raw: false, defval: ""})`.

**Dialog** (`src/components/form-builder/DropdownBulkImportDialog.tsx`): paste or upload → live format detection → ambiguous-header resolver → preview (counts + conflicts, capped rendering, not the full dataset) → Merge/Replace toggle (Merge default) → Replace requires an explicit impact-reviewed confirmation → **`onApply` fires exactly once** with the computed next `options[]`/`branchDrafts[]`. It never imports Supabase and never mutates the caller's draft before Apply; Cancel is a true no-op.

**Wiring** (`src/components/form-builder/FormFieldTemplateEditorDialog.tsx`): the same dialog opens from both the Parent Options and Dependent Fields sections. Dependent Fields is reachable — and import-capable — even with zero existing parent options, since a dependent-table import creates both together in one Apply.

**Matrix** (`src/lib/formBuilder/subFieldPresets.ts`): `inferMatrixColumnsFromDrafts()` builds matrix columns directly from existing `DraftOptionBranch[]` root field_keys (sorted by `display_order`), so the matrix works right after an import with no saved preset required. A saved preset remains the way to define/reuse a standard column structure across templates.

**Validation** (`src/lib/formBuilder/templateEditor.ts`): `validateBranchDraftsIntegrity()` — duplicate root `field_key` per parent and duplicate choices within a branch are **errors**; orphaned parent references and dangling/blank `field_key` (auto-healed on save) are **warnings**.

**Backward compatibility**: `cascadingOptionsCsv.ts` now delegates its line-splitting to the same `parseDelimitedText` (fixing the embedded-newline bug there too), while its exported functions (`parseCsvLine`, `parseCascadingOptionsCsv`, `buildCascadingSampleCsv`, `buildCascadingAiPrompt`) and their tested public behavior are unchanged.

---

## 4) Key files

```
src/lib/formBuilder/dropdownBulkImport.ts          (new — pure parser/normalizer/merge engine)
src/lib/formBuilder/dropdownBulkImportExcel.ts      (new — .xlsx/.xls reading)
src/components/form-builder/DropdownBulkImportDialog.tsx  (new — shared import UI; now i18n-wired + file-size guarded)
src/lib/cascadingOptionsCsv.ts                      (refactored onto the shared parser; public API unchanged)
src/lib/formBuilder/subFieldPresets.ts              (+ inferMatrixColumnsFromDrafts)
src/lib/formBuilder/templateEditor.ts               (+ validateBranchDraftsIntegrity; batch_entry_mode insert-normalization decision — see §9)
src/components/form-builder/FormFieldTemplateEditorDialog.tsx  (wires the dialog into both sections; matrix toolbar search/filter + column-source choice; save-path fixes — see §9)
src/lib/formBuilder/__tests__/dropdownBulkImport.test.ts        (new)
src/lib/formBuilder/__tests__/dropdownBulkImportExcel.test.ts   (new)
src/components/form-builder/__tests__/DropdownBulkImportDialog.test.tsx  (new)
src/components/form-builder/__tests__/FormFieldTemplateEditorDialog.test.tsx  (new — the component had no test file before this branch)
src/lib/formBuilder/__tests__/subFieldPresets.test.ts   (extended)
src/lib/formBuilder/__tests__/templateEditor.test.ts    (extended)
Documentations MD/form-field-template-bulk-dropdown-import-and-matrix.md  (this file)
Documentations MD/index.md
```

15 files total (confirmed via `git diff --name-status origin/main...HEAD`, independently re-verified during the release-readiness audit), no others touched. No SQL migration, no dependency/lockfile change, no Vercel/env config, no server/network config.

---

## 5) Database / migrations

**None.** This is a frontend/draft-state feature only. `options[]` and `DraftOptionBranch[]` remain the single source of truth inside the editor; the only persistence path is the existing `saveOptionBranchConfigurationAtomically`, unchanged. The importer never calls Supabase directly (verified by grep — zero `supabase.` references in the three new core files).

---

## 6) Test plan

- [x] Automated tests: **3165/3165 passing** (168 files), full suite, run twice for stability (identical result both times)
- [x] `tsc --noEmit` — clean
- [x] Production build — succeeds; xlsx confirmed absent from the initial `index-*.js` entry bundle (contained entirely within the already-lazy `CategoryManagement` admin route chunk) — no initial-load regression for the general (non-admin) user base
- [x] `npm run migrations:check` — clean, no new migration files
- [x] `npm run security:secrets` — clean; full `MAIN...DEBUG` diff also manually grepped for password/secret/token/service_role/JWT/private-key/IP/localhost/production-domain patterns — no real secret material, no leakage from the unrelated LAN-IP infrastructure audit performed earlier in this engagement
- [x] Lint on all 15 changed files — **zero errors/warnings** (two pre-existing issues in changed files — a missing `batchEntryMode` hook dependency and a stale `eslint-disable` comment — found and fixed during the release-readiness pass)
- [x] `git diff --check` — clean (no whitespace/conflict-marker issues)
- [x] Independent adversarial code-review pass (dedicated review agent) of the full importer/parser/UI surface against a data-loss, security, performance, and accessibility checklist — 2 confirmed blockers found and fixed (see §7), remainder verified safe or logged as minor/non-blocking
- [x] Live browser QA performed across multiple sessions against real public Vercel previews (production Supabase backend, all mutating tests confined to clearly-labelled disposable `QA ...` records — the two real templates `asd`/`dhdt` and all real categories/expenses/users were never touched): manual entry, flat/comma paste, dependent-table paste (CSV quotes/escaped-quotes/embedded-newline), both import entry points, duplicate-header/header-matching, Merge, Replace (with confirmation + Cancel), Matrix-without-preset, Matrix-with-saved-preset, Matrix search/filter, discard/cancel-never-mutates, real `.xlsx` file upload via an actual file input, real multi-sheet `.xlsx` upload, real legacy `.xls` upload, and a 500-row paste
- [x] Full owner-authorized persistence QA on disposable `QA ...`-labelled records: Category create + reload + reopen; new Select-type Template create via bulk import + `Create Template` + reload + reopen + Matrix reconstruction from DB; Merge-import `Update Template` + reload (old + new values survived); Category↔Template assignment + reload
- [x] Test-quality check: the importer/parser/dialog tests assert real computed output (parsed rows, applied draft arrays, DOM state) rather than mock-call-argument-only or snapshot-only assertions

---

## 7) Save-path correctness, orphan safety, and i18n — release-readiness decisions

This section records the decisions made during the final merge-readiness audit (2026-08-14), each backed by evidence gathered against the live production schema/database, not assumption.

**`batch_entry_mode` NOT NULL fix (root cause of the live "Create Template" HTTP 400 / Postgres `23502`).** The live `expense_form_field_templates.batch_entry_mode` column is `NOT NULL DEFAULT 'per_line'` — schema drift not represented in any repo migration. `buildTemplateData()` still returns `batch_entry_mode: batchEntryMode ?? null` (shared by both insert and update paths); `handleSave`'s **insert-only** call site normalizes `null → "per_line"` immediately before the INSERT. Live-schema verification (read-only, over SSH): 0 of 7 real rows currently have a null `batch_entry_mode` (all pre-date the constraint and were already backfilled), so the update path never actually needs this normalization in practice — confirming the fix is scoped exactly where it's needed and nowhere else. The literal `"per_line"` fallback is not a guess: it is byte-identical to the live column's own `DEFAULT`. **Decision: the current insert-only normalization is architecturally correct and was left unchanged** — moving the default into `buildTemplateData()` or into the initial `useState` would widen the blast radius into the update path and the legacy per-assignment fallback semantics in `batchFieldPlan.ts` for no benefit.

**`expectedUpdatedAt` contract.** New templates call `saveOptionBranchConfigurationAtomically(org, insertedId, null, ...)` — `null`, not the just-inserted row's own `updated_at` — matching the RPC's documented "pass null for new templates (stale check skipped)" contract. Existing templates pass the real `templateUpdatedAt`, keeping the stale-edit guard active. Both directions now have explicit regression tests (`FormFieldTemplateEditorDialog.test.tsx`).

**Partial-create / orphan-template safety (new this pass).** A new Select-type template's save is two separate requests: template INSERT, then branch-configuration RPC. If the RPC fails *after* the INSERT already committed, the template row would previously be left behind with zero dependent-field configuration — a real, reachable failure mode, not merely historical (the original 23502 happened *before* the insert; a branch-RPC failure happens *after* it, and was previously unhandled). Live-schema audit confirmed the safe fix: every FK referencing `expense_form_field_templates` (branch presets, branch config revisions, option branches, category assignments, layout items, form field values) is `ON DELETE CASCADE`, and a template whose branch save just failed has zero rows in any of those tables yet — so the cascade is a true no-op. **Fix:** on branch-RPC failure after a new-template insert, delete exactly the just-inserted row scoped to both its own `id` and the current `organization_id`, then re-throw the original branch error. If the compensating delete itself fails, a distinct message is surfaced telling an admin to check Form Field Templates for an orphaned entry, rather than silently losing track of it. The existing-template update path has no such logic at all — verified by a dedicated regression test that an existing-template branch-save failure never calls delete.

**Duplicate/colliding dependent-table headers (found by the release-readiness adversarial review, fixed this pass).** Two distinct column headers that resolve to the *same* field — either because they both match the same existing `field_key` (e.g. "Project ID" and "project_id") or because they both slugify to the same brand-new `field_key` (e.g. "Project-ID" and "Project_ID") — previously interleaved silently into one field's choice list with no warning at all, and the UI's own summary chip reported them as two distinct matched fields. Fixed by detecting any 2+ headers resolving to the same effective `field_key` and surfacing a new blocking conflict (`duplicate_target_field`) that requires the user to rename one of the source columns before the import can be applied — never guesses which column "wins."

**Import file-size guard (found by the release-readiness adversarial review, fixed this pass).** Uploaded files were read into memory (`file.arrayBuffer()`/`file.text()`) before `MAX_IMPORT_ROWS`/`MAX_IMPORT_COLUMNS` were ever checked, so an accidentally-huge file could freeze the tab before validation ran. A 10MB guard (smaller than `FileUpload.tsx`'s 50MB stored-attachment limit, since this feature only ever parses tabular text/spreadsheet data) now rejects oversized files before any read.

**Debug diagnostic productionized.** `handleSave`'s catch block still logs a structured, non-sensitive `{code, message, details, hint}` object on save failure — this now matches the codebase's own dominant convention for handled catch blocks (`FileUpload.tsx`, `Layout.tsx`, `ProtectedRoute.tsx` all do the same); a dedicated `reportError()`/Sentry helper exists in `src/lib/monitoring.ts` but is not otherwise adopted by feature code, so plain `console.error` is the correct, consistent choice here. The misleading "Temporary… QA, debug branch only" comment has been removed and replaced with an honest description of the convention it follows.

**i18n decision.** `DropdownBulkImportDialog.tsx`'s dialog chrome (title/description, Paste/Upload tabs, sample-download links, dropzone copy, file errors, sheet selector, ambiguous-header resolution UI, format/preview labels, Merge/Replace mode copy, footer buttons, Replace-confirmation dialog) is now wired through `t("dropdownImport.<key>", { defaultValue: "<English>" })`, matching the exact pattern already established by this same editor's Matrix UI (which does have real Hindi/Gujarati translations). English keys were added to `src/locales/en/admin.json`; **Hindi/Gujarati entries were deliberately not fabricated** — professional translation quality matters for a live financial product used by real Hindi/Gujarati-speaking admins, and getting it wrong would be worse than the current, honest English-only state (which is unchanged from before this branch — `t(..., {defaultValue})` always falls back to the English copy when no translated entry exists, exactly as Matrix's own keys did before someone added their hi/gu entries). This mirrors the codebase's own established workflow (Matrix went through the same "keys + English first, translations added later" sequence). Two accessibility findings were fixed opportunistically while wiring this: the ambiguous-header `Select` now carries an `aria-label` tying it to its specific column, and per-metric summary-chip labels/dynamic parser-engine conflict messages were intentionally left in English (scoped decision, not an oversight — those originate from the framework-agnostic parser engine, which is unit-tested against plain-string content by design).

---

## 8) Known limitations

Only real, currently-true limitations — items resolved during the release-readiness pass are documented in §7, not repeated here.

- **`cascadingOptionsCsv.ts`'s `parseCascadingOptionsCsv` is confirmed dead/orphaned code** — its only non-test reference is a doc comment; no live/UI path reaches it. Kept only because the original spec required preserving its exported functions/behavior for any other callers. Safe to remove in a later pass once confirmed no external consumer depends on it.
- No Excel *sample file* generation (`Download Excel sample`) was added — only the existing CSV sample/AI-prompt helpers remain; judged unnecessary complexity for this feature.
- Summary-chip per-metric labels (e.g. "Rows", "Usable rows", "Choices new") and the dynamic conflict/validation messages generated by the parser engine remain English-only by explicit scoped decision (see §7, i18n decision) — the dialog *chrome* is translation-ready, this specific residual scope is not.
- **Two world-readable (0644) production database backup dump files were observed on the self-hosted server during an unrelated infrastructure audit earlier in this engagement** (`/home/webadmin/pesowise-backups/*.dump`) — not part of this feature's scope or diff, flagged here only as an operational hardening note for whoever administers the server.

---

## 9) Related docs

- [Reusable subfield sets & grouped expense layout](./reusable-subfield-sets-and-grouped-expense-layout.md)
- [Scalable form field template editor](./scalable-form-field-template-editor.md)
- [Cascading options bulk import](./cascading-options-bulk-import.md) (DOC-005) — the original CSV-only dependent-table model this feature builds on and wires into the UI for the first time
- [Template-level once-per-batch fields](./template-level-once-per-batch-fields.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-08-13 | 1.0 | Agent | Initial implementation (parser engine, Excel support, shared dialog, matrix column inference, validation hardening, 173 new tests) on `debug/form-field-bulk-import-matrix`, based on latest `main` at the time. |
| 2026-08-13 | 1.1 | Agent | Independent re-verification in a fresh session: fetched and confirmed the branch is still exactly synced to latest `main` (including the just-merged review-hotfix); independently re-ran the full test/build/typecheck/migrations/secrets/lint gauntlet (all clean, matching the implementing session's own claims); independent code-audit agent confirmed all 14 spec requirements PASS; independent diff audit against `main` confirmed exactly the 12 intended files, no dependency/migration/config changes, no direct DB calls, no debug statements, no hardcoded secrets/URLs. Documented here for the first time; live browser QA deferred (see Known limitations). |
| 2026-08-13 | 1.2 | Agent | Manual DEBUG browser QA against a public Vercel preview, logged in as real Mistry & Shah Admin (production Supabase backend — all testing done in an unsaved, never-persisted disposable draft template; the two real production templates were never touched). Exercised manual entry, flat/comma paste, dependent-table paste (CSV quotes/escaped-quotes/embedded-newline all confirmed correct), both import entry points, duplicate-header/header-matching, Merge, Replace (with confirmation + Cancel), Matrix-without-preset, discard/cancel-never-mutates, bad-input handling, and a 500-row paste. **Two bugs found and fixed on this branch:** (1) opening the editor at all (Create or Edit) crashed with `ReferenceError: setBulkInput is not defined` — dangling calls to removed state setters left in the init-on-open effect and the field-type reset callback; (2) the Matrix cell popover's Save trimmed/dropped blanks but never deduped case-insensitively, unlike the bulk-import engine, leaving duplicates to surface only as a blocking validation error instead of being handled transparently. Both fixed by reusing/removing the correct state, with regression tests each verified to fail against the pre-fix code (temporarily reverted, confirmed, restored) before being added — `FormFieldTemplateEditorDialog.test.tsx` created (the component had no test file of its own before this session). Full gauntlet re-run clean after each fix: 3150/3150 tests, tsc, build, migrations-check, secrets-scan, zero new lint issues. |
| 2026-08-13/14 | 1.3 | Agent | Completed remaining manual QA (Tests J/K/L: real `.xlsx`, real multi-sheet `.xlsx`, real legacy `.xls` file uploads via an actual file input, not paste; Test T: Matrix with a saved preset; Test V: Matrix search/filter) plus owner-authorized persistence QA (SAVE TESTs 1-5: QA Category create+persist+reload; QA Template create via bulk import + `Create Template` + reload/reopen + Matrix reconstruction from DB; Merge-import + `Update Template` persistence; QA template↔category assignment) using clearly-labelled disposable `QA ...`-suffixed records only — the two real templates and all real production data were never touched. During SAVE TEST 2, discovered a genuine, reproducible HTTP 400 on `Create Template` for *any* new template (not bulk-import-specific). Root-caused via a temporary diagnostic (`console.error` of the PostgrestError shape) plus a read-only live-schema SSH audit: Postgres `23502` — `expense_form_field_templates.batch_entry_mode` is `NOT NULL DEFAULT 'per_line'` in production, schema drift not represented in any repo migration, while a freshly-opened new-template editor's `batchEntryMode` state legitimately starts `null`. Fixed with a minimal, insert-path-only substitution (`templateData.batch_entry_mode ?? "per_line"`) — proven safe because the `null`-vs-`"per_line"` distinction only matters for the legacy per-assignment fallback on templates with *existing* category assignments, which a brand-new template never has. Also fixed, in the same pass: the `expectedUpdatedAt` contract (new templates must pass `null`, not the just-inserted row's own `updated_at`) and a separate, unrelated bug — the "Save as set" preset button was enabled and silently no-op'd when clicked before a template had ever been persisted (no `parent_template_id` exists yet); now disabled with an explanatory tooltip until the template is saved, and the handler shows a toast instead of silently returning if reached anyway. User independently re-tested the full flow after these fixes and confirmed it working. |
| 2026-08-14 | 2.0 | Agent | **Final release-readiness audit** (independent of all prior implementation/QA sessions): re-verified branch sync to `origin/main` (0 behind, 8 ahead, merge-base = main — unchanged, no sync needed), re-confirmed the exact 15-file diff with no unrelated/suspicious changes and a clean security grep. Fresh full read of the save-path code plus a dedicated adversarial-review pass over the entire importer/parser/dialog surface surfaced two genuine, previously-unflagged **CONFIRMED-BLOCKER** findings, both fixed and regression-tested this pass (full detail in §7): (1) two dependent-table column headers that resolve to the same underlying field silently interleaved their values into one field's choices with zero warning — now blocked with a clear conflict requiring the user to rename a column; (2) uploaded files were read into memory before any size guard — a 10MB guard now applies first. Also implemented and tested this pass: compensating cleanup for the previously-unhandled new-template orphan risk (branch-RPC failure after a successful template insert), a corrected `useCallback` dependency array and a stale `eslint-disable` comment (found via a fresh lint pass), a genuine i18n decision and implementation for `DropdownBulkImportDialog.tsx` (English keys wired via the same pattern as Matrix; Hindi/Gujarati intentionally left for a follow-up professional translation pass rather than fabricated), and productionization of the save-failure diagnostic (misleading "temporary/QA" comment removed; the `console.error` itself kept, matching the codebase's own established convention). Full gauntlet re-run clean: 3165/3165 tests (168 files, run twice for stability), `tsc --noEmit` clean, production build clean (xlsx confirmed absent from the initial bundle), `migrations:check` clean (no new migration), `security:secrets` clean, lint clean across all 15 changed files (two pre-existing issues in changed files fixed), `git diff --check` clean. This document and `index.md` brought to final reality. See the separately-delivered final release report for the complete phase-by-phase evidence and the binary merge-readiness decision. |
