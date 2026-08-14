# Dependent dropdowns — bulk CSV import

**Last updated:** 2026-06-25
**Status:** deployed (frontend)
**ID:** DOC-005

## Purpose

Configure conditional ("dependent") dropdowns in bulk from a CSV instead of building each option by hand. Designed for large catalogs (1500+ rows). Picking the parent option reveals one or more dependent dropdowns at the same time, each filtered to that parent.

## Model (important)

This is a **parent → multiple sibling dropdowns** model, not a chain:

- **Column 1** = the parent dropdown (the select template being edited).
- **Every other column** = a dependent dropdown that appears **together** with the others as soon as a parent option is selected, scoped to that option.

Example:

```csv
Project Unique ID,Project ID,Project Name
UID-001,P-101,Alpha Tower
UID-001,P-102,Alpha Annex
UID-002,P-201,Beta Plaza
```

Selecting `UID-001` shows two dropdowns simultaneously:
- **Project ID** → [P-101, P-102]
- **Project Name** → [Alpha Tower, Alpha Annex]

Each dependent column becomes a root branch per parent option (depth 1), so this only needs the **conditional dropdown** feature (the nested feature is not required for siblings).

## Rules & limits

- 2 columns minimum (parent + 1 dependent). Up to **8 dependent dropdowns**.
- One row per combination; repeat the parent value on each of its rows.
- Parent options dedupe case-insensitively (first spelling kept). Dependent options dedupe within their parent scope.
- Rows with an empty parent cell are skipped; empty dependent cells are ignored.
- Max 5000 rows per import.
- All dependent dropdowns are created as **select** fields.

## How to use

1. Categories → **Templates** → create/edit a **dropdown (select)** template.
2. In **Bulk import dependent dropdowns (CSV)**:
   - **Copy AI prompt** — paste into any AI, add your raw data, and it returns the correctly formatted CSV.
   - **Download sample** — a starter CSV with the right headers.
   - **Import CSV** — load your file; parent options + dependent dropdowns populate the editor below.
3. Review, then **Save**.
4. Assign the template to categories (Assignments tab) so it appears on expense forms.

## AI prompt

The "Copy AI prompt" button copies a ready-to-use instruction (built by `buildCascadingAiPrompt`) that tells an AI exactly how to shape data into the import CSV (headers, one row per combination, quoting rules, example), with a `<PASTE YOUR DATA HERE>` placeholder.

## Key files

- `src/lib/cascadingOptionsCsv.ts` — parser (`parseCascadingOptionsCsv`), sample (`buildCascadingSampleCsv`), AI prompt (`buildCascadingAiPrompt`)
- `src/lib/__tests__/cascadingOptionsCsv.test.ts` — unit tests
- `src/pages/CategoryManagement.tsx` — import UI in the template editor (gated by `allow_conditional_dropdown_fields`)
- Reuses `src/lib/optionBranchPersistence.ts` (`saveDraftBranchesForTemplate`) + the existing template save flow.

## Database

No new migration. Writes go to `expense_form_field_templates.options` and `expense_form_field_option_branches` via the standard admin save path (client-side, admin RLS). Save replaces all branches for the template (delete + reinsert), same as the manual editor.

## Test plan

1. Enable the conditional dropdown feature for the org.
2. Edit a select template → Copy AI prompt / Download sample → Import CSV → confirm parent options and the dependent dropdowns appear in the editor → Save.
3. On an expense form with a category using that template: pick a parent option and verify the dependent dropdowns appear together with only the related options.

## Revision log

| Date | Author | Summary |
|------|--------|---------|
| 2026-06-25 | agent | Initial path-style (chain) import |
| 2026-06-25 | agent | Reworked to parent → multiple sibling dependent dropdowns; added on-screen example, sample, and copyable AI prompt |
