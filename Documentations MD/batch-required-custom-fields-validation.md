# DOC-040 — Batch Required Custom-Field Validation Repair

**Branch:** `staging/mobile-rc`
**Status:** complete
**Last updated:** 2026-07-04

---

## Problem

Required custom form fields (Additional Information fields marked "Required" in Settings) could be submitted blank in the Batch Expense form. The validation existed in `handleSubmit` but had three defects:

1. **Branch field bypass** — the check `Object.keys(branchValues).length > 0` caused branch-field validation to be skipped entirely when a user had not yet entered _any_ branch value, even if a required branch field was visible because its parent dropdown was selected.
2. **Interleaved with writes** — the validation ran inside the same `for` loop that prepared lines for DB submission, meaning a failed validation mid-loop could occur _after_ earlier lines had already been written.
3. **Untestable** — the logic made live Supabase calls inside the loop; there was no pure path to unit-test it.

Additionally, `goNextFromStep2` (step 2 → step 3 transition) performed **zero** custom field validation, letting users reach the review step with blank required fields.

---

## Solution

### 1. Pure validator — `validateBatchCustomFields`

Added to `src/lib/expenseBatchValidation.ts`.

```typescript
validateBatchCustomFields(params: {
  lines: LineCustomFieldInput[];
  categoryFieldSpecs: Map<string, BatchCategoryFieldSpec>;
  batchFormFieldsByCategory: Record<string, Record<string, string>>;
  allowConditionalDropdown: boolean;
  allowNestedConditional: boolean;
  configLoaded: boolean;
}): { ok: true } | { ok: false; message: string }
```

The function is **side-effect-free**: callers pre-fetch field assignments and branches and pass them in. It:

- Returns `{ ok: false }` immediately if `configLoaded = false` (safety guard).
- Validates required branch fields for each line — **without** the `branchValues.length > 0` guard that caused the bypass. `validateVisibleBranchFields` internally determines which branches are visible and checks only those.
- Validates shared (batch-once) required fields once per category.
- Validates per-line required fields for every line.
- Assignment-level `required` field takes precedence over template-level `required`.
- Fields with `show_on_submit = false` are excluded by `splitAssignmentsByBatchMode` before they reach the validator.

#### New exported types

| Type | Purpose |
|------|---------|
| `TemplateFieldAssignment` | Shape of one field assignment row (after mapping `expense_form_field_templates` join). |
| `BatchCategoryFieldSpec` | Pre-split `{ batchOnce, perLine, branches }` for one category. |
| `LineCustomFieldInput` | Per-line input: `lineIndex`, `lineLabel`, `category`, `formFieldValues`, `branchValues`. |

### 2. `buildCategoryFieldSpecs` helper — `ExpenseBatchForm.tsx`

An async inner function added to the form component. Given a list of category names, it:

1. Fetches the category ID from `expense_categories`.
2. Fetches `expense_category_form_fields` with template join for that category.
3. Calls `splitAssignmentsByBatchMode` to split into `batchOnce` / `perLine`.
4. Fetches branch definitions via `ExpenseService.fetchOptionBranchesForCategory` (if `allowConditionalDropdown`).
5. Returns `Map<string, BatchCategoryFieldSpec>`.

### 3. `goNextFromStep2` — now validates custom fields

`goNextFromStep2` was converted from sync to `async`. After the existing base-field and attachment checks, it now:

1. Merges batch-level values with `applyBatchFieldsToLines`.
2. Calls `buildCategoryFieldSpecs` for all categories in the merged lines.
3. Calls `validateBatchCustomFields`.
4. Shows a toast and aborts step transition on failure.

Users now see required-field errors at step 2 (the data-entry step), not only at submit.

### 4. `handleSubmit` — validation moved before writes

The interleaved inline validation loop was replaced with a clean two-phase flow:

**Phase 1 (pre-validation, before `isSubmittingRef.current = true`):**
```
buildCategoryFieldSpecs → validateBatchCustomFields → toast + return on failure
```

**Phase 2 (submission, after guard set):**
Only data preparation (`visibleBranchIds` computation + `linesPrepared.push`) — no validation.

This guarantees no DB writes happen when any required field is blank.

---

## Files changed

| File | Change |
|------|--------|
| `src/lib/expenseBatchValidation.ts` | Added `TemplateFieldAssignment`, `BatchCategoryFieldSpec`, `LineCustomFieldInput` types; added `validateBatchCustomFields` function; added imports for `OptionBranchDefinition` and `validateVisibleBranchFields`. |
| `src/pages/ExpenseBatchForm.tsx` | Added `buildCategoryFieldSpecs` inner helper; made `goNextFromStep2` async and added custom-field validation; refactored `handleSubmit` to call `validateBatchCustomFields` before writes; removed inline validation loop; removed unused `validateVisibleBranchFields` import; added `BatchCategoryFieldSpec`, `LineCustomFieldInput`, `validateBatchCustomFields` to import. |
| `src/lib/__tests__/batchCustomFieldValidation.test.ts` | **New file** — 22 tests (CF-1 through CF-22). |

---

## Test coverage (22 new tests — CF-1 to CF-22)

| ID | Scenario |
|----|----------|
| CF-1 | Required per-line field empty → `ok: false` |
| CF-2 | Required per-line field filled → `ok: true` |
| CF-3 | Optional per-line field empty → `ok: true` |
| CF-4 | Required shared field empty → `ok: false` |
| CF-5 | Required shared field filled → `ok: true` |
| CF-6 | Optional shared field empty → `ok: true` |
| CF-7 | Multiple lines; second line fails → error includes second line's label |
| CF-8 | Category with no spec in map → `ok: true` (graceful) |
| CF-9 | Required branch visible (parent selected) but empty → `ok: false` |
| CF-10 | Required branch visible and filled → `ok: true` |
| CF-11 | Required branch but parent not selected (not visible) → `ok: true` |
| CF-12 | `allowConditionalDropdown=false` → branch check skipped → `ok: true` |
| CF-13 | `configLoaded=false` → `ok: false` (safety guard) |
| CF-14 | Per-line field value `"0"` (non-empty) → `ok: true` |
| CF-15 | Per-line field value `"  "` (whitespace only) → `ok: false` |
| CF-16 | Shared field whitespace-only value → `ok: false` |
| CF-17 | `show_on_submit=false` assignment excluded from validation → `ok: true` |
| CF-18 | Assignment `required=false` overrides template `required=true` → `ok: true` |
| CF-19 | `ask_once_per_batch=null` treated as perLine, not batchOnce |
| CF-20 | `ask_once_per_batch=true` treated as batchOnce |
| CF-21 | Shared field error message includes category name |
| CF-22 | Per-line error message includes line label (title) |

All 22 tests pass. 50/50 test files pass. `npx tsc --noEmit` is clean.

---

## Key invariants

- **No writes before validation** — `isSubmittingRef.current = true` is only set after `validateBatchCustomFields` returns `{ ok: true }`.
- **No bypass when branchValues is empty** — the empty-branchValues guard has been removed; `validateVisibleBranchFields` handles visibility internally.
- **Config-loading safety** — if `configLoaded = false`, submission is blocked (unreachable in practice since the form only renders after config loads, but defensive).
- **Assignment overrides template** — `field.required != null ? field.required : template.required` — explicit override on the assignment row wins.
- **show_on_submit=false excluded** — `splitAssignmentsByBatchMode` filters these out before they reach the validator.

---

## Related docs

- [DOC-036 Batch Form Configuration Parity](./batch-form-configuration-parity.md) — base field labels in batch form
- [DOC-011 Batch Expense Bugs — Duplicate Submission & Visibility](./batch-expense-bugs.md) — `isSubmittingRef` guard
- [DOC-001 Custom Form Fields — Review Display](./custom-form-fields-review-display.md) — custom field data model

---

## Index revision log

| Date | Change |
|------|--------|
| 2026-07-04 | DOC-040 created — batch required custom-field validation repair |
