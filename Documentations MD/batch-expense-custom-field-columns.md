# Batch expense review — org custom field columns

**Doc ID:** DOC-012  
**Status:** in progress  
**Last updated:** 2026-06-29  
**Owner / area:** Expenses, Batch Review

---

## 1) Summary

The consolidated expenses table in the batch expense review panel now shows organisation-specific custom form field values as extra columns. Each column header is the field's display name; cells show the submitted value for that expense, or "—" if the field wasn't filled in. Columns are hidden on mobile (shown from `md` breakpoint up).

---

## 2) Problem / requirement

Organisations configure custom form fields (e.g. "Project Code", "Cost Centre") via the form builder. These values were visible in individual expense detail dialogs but were invisible in the batch review table, requiring reviewers to open each expense to see them.

---

## 3) Solution

- **`src/lib/batchExpenseReview.ts`** — added `BatchCustomFieldResult` type, `customFields?: Record<string, string>` on `BatchReviewExpenseRow`, and `fetchBatchExpenseCustomFields(expenseIds, organizationId)` which:
  1. Fetches all `expense_form_field_values` rows for the batch in one query.
  2. Collects the unique `template_id` and `branch_field_id` values, then resolves their display names via two parallel queries (`expense_form_field_templates` + `expense_form_field_option_branches`).
  3. Skips `field_value = ""` and `"false"` (unchecked checkboxes); renders `"true"` as `"Yes"`.
  4. Returns `columns` (sorted alphabetically) and `valuesByExpenseId` (Map from expense ID → label→value record).

- **`src/components/BatchExpenseReviewPanel.tsx`** — wires the fetch into `loadBatch` via `Promise.all` alongside the existing profiles and `correctedIds` fetches (no added latency). Maps `customFields` onto each `BatchReviewExpenseRow`. Renders one `<TableHead>` per column after "Purpose" and one `<TableCell>` per column after the purpose cell.

---

## 4) Key files

```
src/lib/batchExpenseReview.ts
src/components/BatchExpenseReviewPanel.tsx
```

---

## 5) Database / migrations

No schema changes. Reads from existing tables:
- `expense_form_field_values`
- `expense_form_field_templates`
- `expense_form_field_option_branches`

---

## 6) Test plan

- [ ] Open batch review for an org that has custom form fields — extra columns appear in the header with the field names.
- [ ] Expenses that have values for a field show the value in that column; expenses without it show "—".
- [ ] Boolean `true` values (checkboxes ticked) display as "Yes".
- [ ] Boolean `false` / empty values are not shown (cell shows "—").
- [ ] Columns are hidden on mobile-width viewport; visible at `md` (768px+).
- [ ] Org with no custom form field values: no extra columns appear.
- [ ] Batch load time is not noticeably increased (fetch runs in parallel with profiles + corrections).

---

## 7) Related docs

- [DOC-001 — Custom form fields review display](./custom-form-fields-review-display.md)
- [DOC-011 — Batch expense bugs](./batch-expense-bugs.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-29 | 1.0 | Agent | Initial implementation — parallel fetch + table columns/cells |
