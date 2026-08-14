# Expense Detail View — Field Order Builder

**Doc ID:** DOC-010
**Status:** in progress
**Last updated:** 2026-06-26
**Owner / area:** Settings, Expense Detail View, Custom Form Fields

---

## 1) Summary

Admins can now reorder the **Additional Information** fields that appear when viewing an expense
detail (the sheet/dialog that opens when clicking "Open" on an expense). The new "Expense Detail
View — Field Order" card in Settings shows all custom form field templates with up/down arrows
and a Save button. Changes propagate to all expense categories immediately.

---

## 2) Problem / requirement

The expense detail view renders custom fields in the order driven by
`expense_category_form_fields.display_order`. Previously there was no admin UI to change this
order — admins had to work around it by deleting and re-creating category field assignments.
The user request: move "From location" and "To location" below the project-related fields.

---

## 3) Solution

A new Settings card **"Expense Detail View — Field Order"** (admin-only, between "Expense Form
Builder (Base Fields)" and "Organization Logo") that:

1. **Loads** all `expense_form_field_templates` for the org, sorted by the minimum
   `expense_category_form_fields.display_order` across all category assignments.
2. **Displays** them in a numbered list with **↑ / ↓ arrow buttons** per row.
3. **Saves** by issuing one `UPDATE expense_category_form_fields SET display_order = N WHERE
   template_id = X AND organization_id = Y` per template, using the new array position × 10 as
   the display order value.

No DB migration required — `expense_category_form_fields.display_order` already exists.

The rendering code in `fetchExpenseFormFieldDisplay.ts` / `buildRowsFromCategoryAssignments`
already picks up `assignment.display_order` as the primary sort key, so saving through
the new Settings card takes effect immediately in all expense detail views and review dialogs.

---

## 4) Key files

```
src/pages/Settings.tsx   (new state + fetchDetailViewFields + moveDetailViewField + saveDetailViewOrder + Card UI)
```

No other files changed. `fetchExpenseFormFieldDisplay.ts` already handles the order correctly.

---

## 5) Database / migrations

None. Uses `expense_category_form_fields.display_order` (existing column, added in
`20250130000004_create_expense_form_fields.sql`).

---

## 6) Test plan

- [ ] Open Settings → confirm "Expense Detail View — Field Order" card appears with all custom
      fields listed (e.g. From location, To location, Project Unique ID, Project ID, Project Name).
- [ ] Move "From location" below "Project Name" using the ↓ arrow. Click "Save View Order".
- [ ] Open any expense that belongs to the same category → Additional Information section should
      now show Project fields first, From/To location last.
- [ ] Reorder fields back to original. Save. Confirm order restored in detail view.
- [ ] Verify the ↑ button is disabled on the first row and ↓ is disabled on the last row.

---

## 7) Related docs

- DOC-004: [`base-field-input-customization.md`](./base-field-input-customization.md) — base field label/input-type builder (different table)
- DOC-001: [`custom-form-fields-review-display.md`](./custom-form-fields-review-display.md) — review dialog custom fields display

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-26 | 1.0 | Agent | Initial implementation — up/down reorder UI for Additional Information fields in expense detail view. |
