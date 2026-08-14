# Singular Expense Correction — Custom Field Data Safety

**Doc ID:** DOC-046  
**Last updated:** 2026-07-07  
**Status:** complete

---

## Summary

When a manager, admin, or assigned engineer corrects a single expense through the AdminPanel or EngineerReview correction dialog, there were two data-loss risks:

1. **Non-atomic writes** — base field update (via `apply_expense_correction`) and custom field update (via `replace_expense_form_field_values_by_reviewer`) happened in separate round-trips. A network failure between them left base fields saved and custom fields wiped, or vice versa.

2. **Blanket-replace semantics** — `replace_expense_form_field_values_by_reviewer` deleted ALL custom field values for the expense and re-inserted only what the reviewer's model contained. If the model was partially loaded (e.g. `show_on_submit` filter hid some fields), those hidden fields were silently deleted.

Both problems are resolved by this change. The correction dialog is now powered by a single atomic database transaction and uses explicit patch semantics: only fields the reviewer actually loaded and changed are touched.

---

## Root causes

### Cause 1 — Non-atomic two-call pattern

`applyExpenseCorrectionByReviewer` in `ExpenseService.ts`:

```typescript
// Call 1: base fields (separate transaction on DB)
await supabase.rpc("apply_expense_correction", { p_expense_id, p_updates, p_reason });

// ... audit log call ...

// Call 2: custom fields (separate transaction on DB — NOT atomic with call 1)
await this.replaceExpenseFormFieldValuesByReviewer(expenseId, organizationId, payload);
```

If the network drops between call 1 and call 2:
- Base fields are saved with status = 'edited'
- Custom fields remain at their old values
- No error is surfaced to the reviewer; the dialog closes as if everything succeeded

### Cause 2 — Blanket-replace semantics

`replace_expense_form_field_values_by_reviewer` deletes the entire custom field set:

```sql
DELETE FROM expense_form_field_values
WHERE expense_id = p_expense_id AND organization_id = p_organization_id;
-- Then inserts only what the client sent
```

Combined with the `show_on_submit` filter in `loadCorrectionCustomFields` (which hid fields where `show_on_submit = false`), any field configured as hidden-on-submit would be loaded as absent in the correction model. When the reviewer submitted the correction, those fields were deleted because they weren't in the payload.

### Cause 3 — No audit trail for custom field changes

Before this fix, there was no record of custom field changes on an expense. Only the `expense_correction_logs` table existed, which only captured base field (title, amount, etc.) changes.

---

## Changes made

### 1. `src/lib/loadCorrectionCustomFields.ts`

**`show_on_submit` filter removed.** The filter that hid fields where `show_on_submit = false` is gone. The correction dialog now loads every configured field for the category, regardless of whether it was shown to the submitter.

**Category lookup uses `limit(2)` instead of `maybeSingle()`.** This allows explicit ambiguity detection: if two or more categories share the same name, the loader sets `loadError` instead of silently returning empty.

**`CorrectionCustomFieldsModel` extended with:**

| New field | Type | Purpose |
|---|---|---|
| `initialFormFieldValues` | `Record<string, string>` | Immutable snapshot captured at load time |
| `initialBranchValues` | `Record<string, string>` | Immutable snapshot captured at load time |
| `categoryId` | `string \| null` | Resolved DB category ID |
| `loadError?` | `string` | Human-readable error when category fails to resolve |

The initial snapshots are shallow copies of `formFieldValues` and `branchValues` at the moment the loader returns. They are preserved unchanged when `setCorrFieldModel` updates `formFieldValues` or `branchValues` via the spread pattern.

### 2. `src/lib/buildCorrectionCustomFieldPatch.ts` (new file)

Pure function `buildCorrectionCustomFieldPatch(model, visibleBranchIds): PatchItem[]`.

```typescript
export type PatchItem = {
  template_id: string | null;
  branch_field_id: string | null;
  operation: "set" | "clear";
  old_value: string | null;
  new_value: string | null;
};
```

**Rules (tested in SCS-1 through SCS-13):**

| Scenario | Item emitted |
|---|---|
| Initial value === current value | None |
| Value changed | `"set"` with old and new |
| Value cleared (was non-empty, now empty/whitespace) | `"clear"` with old |
| Field was empty and still empty | None |
| Branch becomes invisible AND had stored value | `"clear"` to clean up DB |
| Branch becomes invisible AND had no stored value | None |
| Template ID not in loaded model | Excluded (unloaded exclusion) |
| Checkbox stays at default `"false"` | None |

Whitespace-only strings are normalised to `null` before comparison.

### 3. `supabase/migrations/290707_2000_singular_correction_safety.sql` (new file, manual)

**DO NOT apply automatically.** Run in Supabase SQL editor after verifying on staging.

Contains:

| Object | Description |
|---|---|
| `expense_form_field_value_history` table | Append-only audit log; never delete rows |
| `fn_archive_expense_form_field_value()` trigger function | Safety net: archives every UPDATE or DELETE on `expense_form_field_values` via legacy code |
| `trg_efv_archive_changes` trigger | Fires AFTER UPDATE OR DELETE on `expense_form_field_values` |
| Baseline snapshot INSERT | Idempotent — inserts one `'baseline'` history row per existing value |
| `apply_singular_expense_correction` RPC | Atomic base + custom field patch in one transaction |

**`apply_singular_expense_correction` signature:**
```sql
apply_singular_expense_correction(
  p_expense_id       UUID,
  p_organization_id  UUID,
  p_updates          JSONB,   -- base field changes; empty {} if custom-fields only
  p_reason           TEXT,
  p_patch            JSONB    -- array of PatchItem
) RETURNS JSONB
```

**Authorization matches the union of both old RPCs:**
- Org admin (`role = 'admin'`)
- Assigned engineer (`assigned_engineer_id = auth.uid()`)
- Assigned reviewer (`assigned_reviewer_id = auth.uid()`)
- Hierarchy role (`role IN ('manager', 'executive', 'team_leader')`)

**What it does in one transaction:**
1. Lock expense row (`FOR UPDATE`)
2. Check feature flag (`allow_manager_admin_expense_corrections`)
3. Validate: status not in draft/approved/paid; user is not the expense owner
4. Apply base field updates with same validation as `apply_expense_correction`
5. Update expense `status = 'edited'`
6. Write `expense_correction_logs` if base fields changed
7. Set `app.skip_archive_trigger = 'true'` to prevent double-archiving
8. For each patch item: upsert (`"set"`) or delete (`"clear"`) + write to history
9. Reset `app.skip_archive_trigger = 'false'`
10. Return result JSON

**Trigger suppression mechanism:**
The trigger `trg_efv_archive_changes` fires on any UPDATE/DELETE and is a safety net for legacy code paths (e.g. batch corrections that still use `replace_expense_form_field_values_by_reviewer`). The new RPC sets a session-local PostgreSQL variable `app.skip_archive_trigger = 'true'` before its DML so the trigger is a no-op during the RPC's own writes. The RPC archives changes explicitly into `expense_form_field_value_history` with the correction log ID attached.

### 4. `src/services/ExpenseService.ts`

New method `applySingularExpenseCorrection(expenseId, editorUserId, updates, reason, patch)`:
- Calls the new `apply_singular_expense_correction` RPC (one DB call)
- Logs audit action
- Sends correction notification (best-effort; errors are caught and logged)

The old `applyExpenseCorrectionByReviewer` method is kept unchanged for backward compatibility (batch corrections still use it via `replace_expense_form_field_values_by_reviewer`).

### 5. `src/pages/AdminPanel.tsx` and `src/pages/EngineerReview.tsx`

In `submitExpenseCorrection`:

**Before:**
```typescript
await ExpenseService.applyExpenseCorrectionByReviewer(
  expenseId, userId, baseUpdates, reason,
  formFieldValues, branchValues, visibleBranchIds,
);
```

**After:**
```typescript
const patch = corrFieldModel.categoryFormFields.length > 0
  ? buildCorrectionCustomFieldPatch(corrFieldModel, visibleBranchIds)
  : [];

await ExpenseService.applySingularExpenseCorrection(
  expenseId, userId, baseUpdates, reason, patch,
);
```

The patch is an array of explicit `PatchItem` objects computed by diffing `initialFormFieldValues` / `initialBranchValues` against the current `formFieldValues` / `branchValues`.

**Load error display:** If `corrFieldModel.loadError` is set (category not found or ambiguous), a warning banner appears in the correction dialog above the custom fields section. The reviewer can still correct base fields.

---

## What is NOT changed

- `applyExpenseCorrectionByReviewer` — kept as-is; used by batch review paths (out of scope)
- `replace_expense_form_field_values_by_reviewer` — kept as-is; still used by batch corrections
- `BatchExpenseReviewPanel`, `ExpenseBatchForm`, batch validation logic — untouched
- Receipt handling, Storage, Edge Functions, navigation, mobile UI, Analytics, Reports, User Management — untouched

---

## Destructive write inventory after this fix

| Code path | Table | Operation | Still dangerous? |
|---|---|---|---|
| `replace_expense_form_field_values_by_reviewer` | `expense_form_field_values` | Blanket DELETE + INSERT | Yes, for batch corrections. Archived by trigger now. |
| `replace_expense_form_field_values` | `expense_form_field_values` | Blanket DELETE + INSERT | Yes, for expense owner saves. Archived by trigger now. |
| `apply_singular_expense_correction` (new) | `expense_form_field_values` | Explicit patch per item | No — patch semantics, never bulk-deletes |
| `saveDraftBranchesForTemplate` | `expense_form_field_option_branches` | DELETE + INSERT | Guarded (see DOC-045) |

---

## Schema

```sql
expense_form_field_value_history
  id                        UUID  PK DEFAULT gen_random_uuid()
  expense_id                UUID  FK → expenses(id) ON DELETE CASCADE
  organization_id           UUID  FK → organizations(id) ON DELETE CASCADE
  template_id               UUID  FK → expense_form_field_templates(id) ON DELETE SET NULL
  branch_field_id           UUID  FK → expense_form_field_option_branches(id) ON DELETE SET NULL
  old_value                 TEXT
  new_value                 TEXT
  operation                 TEXT  CHECK IN ('set','clear','baseline')
  changed_by                UUID  FK → auth.users(id) ON DELETE SET NULL
  reason                    TEXT
  expense_correction_log_id UUID  FK → expense_correction_logs(id) ON DELETE SET NULL
  created_at                TIMESTAMPTZ DEFAULT now()
```

RLS: read-only for the expense owner, assigned engineer/reviewer, and hierarchy roles.

---

## How to verify after migration

**1. Check that an expense correction is atomic:**
```
Open the correction dialog for expense E.
Change a base field (e.g. title) and a custom field.
Submit.
```
Expected: Both changes appear immediately. If any DB error occurs, BOTH are rolled back (no partial state).

**2. Check that unloaded fields are not wiped:**
```sql
-- Before correction
SELECT template_id, field_value FROM expense_form_field_values WHERE expense_id = 'E';

-- Open correction dialog (only some fields are visible)
-- Change one visible field. Submit.

-- After correction
SELECT template_id, field_value FROM expense_form_field_values WHERE expense_id = 'E';
-- Fields not touched by the patch should be unchanged.
```

**3. Check the history table after a correction:**
```sql
SELECT operation, old_value, new_value, changed_by, created_at
FROM expense_form_field_value_history
WHERE expense_id = 'E'
ORDER BY created_at DESC;
-- Should show one row per changed field plus the baseline rows.
```

**4. Check that show_on_submit=false fields appear in the dialog:**
Open the correction dialog for an expense whose category has a field with `show_on_submit = false` (or where the assignment has `show_on_submit = false`). The field should appear. Before this fix, it was invisible.

**5. Verify the trigger fires on legacy paths:**
```sql
UPDATE expense_form_field_values SET field_value = 'test' WHERE id = 'some-row-id';
SELECT * FROM expense_form_field_value_history WHERE expense_id = 'matching-expense-id' ORDER BY created_at DESC LIMIT 1;
-- Should see the update archived by the trigger.
```

---

## Manual migration steps

Run `supabase/migrations/290707_2000_singular_correction_safety.sql` in the Supabase SQL editor (project `avrbgpmzabktqwyzqibq`):

1. Open Supabase dashboard → SQL Editor → New query
2. Paste the contents of the migration file
3. Click **Run** — the entire script is one transaction
4. Verify in the Table Editor that `expense_form_field_value_history` exists
5. Verify the trigger exists: `SELECT tgname FROM pg_trigger WHERE tgrelid = 'expense_form_field_values'::regclass;`
6. Verify the RPC exists: `SELECT proname FROM pg_proc WHERE proname = 'apply_singular_expense_correction';`
7. In Supabase → Settings → API → click **Reload** to refresh the PostgREST schema cache
8. Deploy the frontend code
9. Test a correction in the correction dialog (base + custom fields)
10. Check `expense_form_field_value_history` for the new rows

---

## Tests

`src/lib/__tests__/singularCorrectionDataSafety.test.ts` — 20 tests (SCS-1 through SCS-20)

| Range | Covers |
|---|---|
| SCS-1 to SCS-13 | `buildCorrectionCustomFieldPatch` — all branching paths |
| SCS-14 to SCS-20 | `loadCorrectionCustomFields` — guard, error, show_on_submit, initial snapshots |

---

## Revision log

| Date | Rev | Notes |
|---|---|---|
| 2026-07-07 | 1.0 | Initial document — both root causes fixed; atomic RPC, patch builder, history table |
