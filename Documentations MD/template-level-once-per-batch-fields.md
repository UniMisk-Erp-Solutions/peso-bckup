# DOC-065 — Template-Level "Once per Batch" Fields

**Status:** complete (Phases E/F/G/H + full repair: presentation-only BatchLineFormFields, central plan wiring, bug fixes, regression tests)  
**Branch:** `feature/user-activity-insights`  
**Date:** 2026-07-16

---

## 1. Overview

Previously, "ask once per batch" was a per-assignment flag (`ask_once_per_batch` on `expense_category_form_fields`). This had two problems:

1. **Category-name deduplication**: when the same template was assigned to two categories, `BatchSharedCategoryFields` asked it twice (once per category section).
2. **Non-transferable**: changing the flag required updating every assignment individually.

This feature moves the setting to the **template level** (`batch_entry_mode` on `expense_form_field_templates`), with the **template ID** as the deduplication key.

---

## 2. Key Invariants

- Template ID is the identity key, not category name.
- Same template assigned to N categories → asked **only once** (merged `SharedBatchField` with all category IDs).
- Conditional child fields inherit the root template's batch_entry_mode scope.
- Legacy `ask_once_per_batch = true` on an assignment with no `batch_entry_mode` on the template is treated as `once_per_batch` (fallback — see `resolveAssignmentBatchMode`).
- Per-line fields remain per-line regardless of template settings.
- Single-expense entry is unchanged.

---

## 3. New Column

**Table:** `expense_form_field_templates`  
**Column:** `batch_entry_mode TEXT CHECK (IN ('once_per_batch', 'per_line'))`  
**Default:** `NULL` (treated as `per_line` by client)

Migration file: `supabase/migrations/20260716120000_template_batch_entry_mode.sql`  
**NOT applied in production.** Requires DBA approval.

---

## 4. Files

### 4.1 Pure model

| File | Role |
|------|------|
| `src/lib/batchFieldPlan.ts` | `BatchFieldAssignment`, `BatchFieldPlan`, `SharedBatchField`, `PerLineBatchField`, `buildBatchFieldPlan()`, `resolveAssignmentBatchMode()`, `applyBatchFieldPlanToLines()`, `getActiveCategoryIds()` |
| `src/hooks/useBatchFieldPlan.ts` | React hook: one-shot fetch for all category assignments, builds `BatchFieldPlan` in `useMemo` |

### 4.2 SQL files

| File | Purpose |
|------|---------|
| `docs/sql/template-batch-entry-mode/00_preflight_template_batch_modes.sql` | Pre-migration read-only checks |
| `docs/sql/template-batch-entry-mode/01_add_template_batch_entry_mode.sql` | Main migration (add column + backfill) |
| `docs/sql/template-batch-entry-mode/02_verify_template_batch_mode_backfill.sql` | Post-migration verification |
| `docs/sql/template-batch-entry-mode/03_verify_batch_field_applicability.sql` | Cross-check template vs assignment modes |
| `docs/sql/template-batch-entry-mode/99_rollback_template_batch_entry_mode_DO_NOT_RUN.sql` | Rollback (DROP COLUMN) — requires DBA authorization |

### 4.3 Template editor

| File | Change |
|------|--------|
| `src/lib/formBuilder/templateEditor.ts` | `buildTemplateData()` now includes `batch_entry_mode`; `TemplateEditorSnapshot` includes `batchEntryMode` |
| `src/components/form-builder/FormFieldTemplateEditorDialog.tsx` | New `batchEntryMode` state + toggle in `BasicsPanel` ("Ask once per batch" switch) |

---

## 5. `resolveAssignmentBatchMode` Logic

```typescript
function resolveAssignmentBatchMode(assignment): BatchEntryMode {
  const templateMode = assignment.template?.batch_entry_mode;
  if (templateMode === "once_per_batch" || templateMode === "per_line") return templateMode;
  // Legacy fallback
  if (assignment.ask_once_per_batch === true) return "once_per_batch";
  return "per_line";
}
```

---

## 6. `buildBatchFieldPlan` Behavior

Input: all assignments for all active categories.  
Output: `{ shared: SharedBatchField[], perLine: PerLineBatchField[] }`

- Shared fields: one entry per unique template ID across all active categories.
- Each `SharedBatchField` carries `categoryIds: string[]` — all categories that share this template.
- During submit, `applyBatchFieldPlanToLines` applies the shared values to every line whose `category_id` is in the shared field's `categoryIds`.

---

## 7. One-Fetch Design

`useBatchFieldPlan` fetches assignments for **all** active category IDs in a single Supabase query, then builds the plan in `useMemo`. This avoids N+1 per-category fetches.

---

## 8. Phase G — ExpenseBatchForm wiring (complete)

| File | Change |
|------|--------|
| `src/components/BatchSharedCategoryFields.tsx` | Rewritten: accepts `SharedBatchField` prop (no internal DB fetch). Renders using `[sharedField.assignment]`. |
| `src/pages/ExpenseBatchForm.tsx` | Uses `useBatchFieldPlan` hook; `batchSharedFormValues` state keyed by template ID; `applyBatchFieldPlanToLines` on submit/validation; template-deduped shared field rendering. |
| `src/lib/expenseBatchValidation.ts` | Added `validateBatchCustomFieldsFromPlan` + `BatchSharedFormValues` type (plan-aware, no N+1 assignment fetches). |
| `src/components/CategoryFieldAssignmentSortList.tsx` | Shows "once per batch (template)" badge when `batch_entry_mode_from_template` is set; hides legacy toggle for template-controlled fields. |

---

## 9. Phase H — i18n translations (complete)

Added `systemStatus` key group to `src/locales/{en,hi,gu}/common.json`:

| Key | EN |
|-----|----|
| `systemStatus.statusPage` | "Status page" |
| `systemStatus.dismissNotification` | "Dismiss notification" |
| `systemStatus.viewLiveStatus` | "View live status page" |
| `systemStatus.checkAgain` | "Check again" |
| `systemStatus.estimatedRestoration` | "Estimated restoration:" |
| `systemStatus.lastChecked` | "Last checked:" |
| `systemStatus.maintenance.defaultTitle` | "Scheduled Maintenance" |
| `systemStatus.maintenance.defaultMessage` | "PesoWise is undergoing scheduled maintenance…" |
| `systemStatus.outage.defaultTitle` | "Service Outage" |
| `systemStatus.outage.defaultMessage` | "PesoWise is currently experiencing a service outage…" |

Components updated to use `t()`:
- `SystemAlertBanner.tsx` — "Status page" link, "Dismiss notification" aria-label
- `SystemUnavailableScreen.tsx` — all fallback titles, messages, and action labels

---

## 10. Full Repair (2026-07-16)

Four bugs were fixed to make the once-per-batch system fully functional end-to-end:

| # | Bug | Fix |
|---|-----|-----|
| BUG-1 | `useBatchFieldPlan` queried non-existent columns (`label`, `is_required`) — PostgREST rejected the nested query, returning null | Changed select to use real column names: `name`, `required`, added `help_text`, `batch_entry_mode` |
| BUG-2 | `BatchLineFormFields` fetched its own assignments (DB query inside component) | Rewritten as presentation-only — caller passes pre-resolved `assignments` prop |
| BUG-3 | `BatchLineFormFields` called `splitAssignmentsByBatchMode()` which only checked legacy `ask_once_per_batch`, ignoring `template.batch_entry_mode` | Removed — classification is now done entirely by `buildBatchFieldPlan` in the central hook |
| BUG-4 | `ExpenseBatchForm` passed all assignments (including once_per_batch ones) to each line card | Wired to use `getPerLineAssignmentsForCategory(plan, catId)` — once_per_batch templates never reach line cards |
| BUG-5 | `validateBatchCustomFieldsFromPlan` used `tmpl.is_required` (non-existent column) | Fixed to `tmpl.required` at both shared and per-line validation sites |

Key file changes in this repair pass:

| File | Change |
|------|--------|
| `src/lib/batchFieldPlan.ts` | Fixed `BatchFieldAssignment` type (removed `label`, `is_required` → `required`); added `getPerLineAssignmentsForCategory`, `getPerLineSelectTemplateIds` |
| `src/hooks/useBatchFieldPlan.ts` | Fixed select query column names; added `error: Error \| null` and `reload: () => void` to result type |
| `src/components/BatchLineFormFields.tsx` | Rewritten as presentation-only; new props: `assignments`, `optionBranches`, `userId` |
| `src/lib/expenseBatchValidation.ts` | Fixed `is_required` → `required` in `validateBatchCustomFieldsFromPlan` |
| `src/pages/ExpenseBatchForm.tsx` | Uses `getPerLineAssignmentsForCategory`; added error/retry UI; disabled Review when plan has error |

---

## 11. Tests

| File | Tests | Coverage |
|------|-------|---------|
| `src/lib/__tests__/batchFieldPlan.test.ts` | 12 | `resolveAssignmentBatchMode` (4 cases), `buildBatchFieldPlan` (5 cases), `applyBatchFieldPlanToLines` (1 case), `getActiveCategoryIds` (2 cases) |
| `src/lib/__tests__/expenseBatchValidationPlan.test.ts` | 12 | `validateBatchCustomFieldsFromPlan`: configLoaded guard (T69), empty plan (T70), shared required missing/filled (T71–72), per-line required missing/filled (T73–74), category scoping (T75), optional fields (T76), dedup across two categories (T77–78), whitespace handling (T79–80) |
| `src/lib/__tests__/oncePerBatchInvariants.test.ts` | 30 | `resolveAssignmentBatchMode` precedence (T-R1–R6), plan structure invariants (T-P1–P9), `getPerLineAssignmentsForCategory` (T-G1–G4), `getPerLineSelectTemplateIds` (T-S1–S2), `applyBatchFieldPlanToLines` copy behavior (T-A1–A2), validation with correct column name (T-V1–V5), category label list (T-L1–L2) |

All 54 tests pass alongside the pre-existing suite (77 test files / 1215 tests total).
