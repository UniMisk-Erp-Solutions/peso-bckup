# Batch expense — shared title (entered once per batch)

**Doc ID:** DOC-014  
**Status:** in progress  
**Last updated:** 2026-06-29  
**Owner / area:** Expenses, Batch

---

## 1) Summary

The batch expense creation form now collects the expense **Title once in Step 1** (alongside Batch Label and Date) instead of asking the user to type it separately for every line item. All line items automatically share the same title. No backend or SQL changes — pure frontend.

---

## 2) Problem / requirement

Users entering batch expenses (e.g. travel reimbursements for a trip) had to type an identical title on every individual line, which was repetitive and error-prone.

---

## 3) Solution

- **`src/pages/ExpenseBatchForm.tsx`**
  - Added `sharedTitle: string` state variable (alongside `sharedDestination`, `batchLabel`).
  - Added `handleSharedTitleChange(title)` — sets `sharedTitle` state and simultaneously patches every existing line's `title` field via `setLines(prev => prev.map(l => ({ ...l, title })))`.
  - Added a "Title" input in the **Step 1** UI (between Batch Label and Expense Date), guarded by `getBaseField("title").is_visible`. Shows `" *"` suffix when required, `" (same for all expenses)"` otherwise.
  - Added title validation in `goNextFromStep1`: if the field is visible+required and `sharedTitle` is blank, shows a destructive toast and blocks navigation.
  - When "Add line" is clicked, new lines are created with `{ ...newLine(), title: sharedTitle }` so they immediately inherit the shared title.
  - `resetBatchFormState` now also resets `sharedTitle` to `""`.
  - In the **card view** (Step 2), replaced the editable per-line title `BaseExpenseFieldInput` with a read-only `<p>` that displays the shared title (greyed `—` when blank).
  - Passes `sharedTitle={sharedTitle}` to `BatchExpenseLinesTable`.

- **`src/components/BatchExpenseLinesTable.tsx`**
  - Added `sharedTitle?: string` to `BatchExpenseLinesTableProps`.
  - When `sharedTitle !== undefined` (i.e. the prop is passed), hides the "Title" column header and the per-row title cell entirely.

---

## 4) Key files

```
src/pages/ExpenseBatchForm.tsx
src/components/BatchExpenseLinesTable.tsx
```

---

## 5) Database / migrations

No schema changes. `BatchLineInput.title: string` is still set per line — the shared value is just propagated from the single input on the frontend.

---

## 6) Test plan

- [ ] Open batch expense form → Step 1 shows a "Title" input below Batch Label
- [ ] Type a title → proceed to Step 2; card view shows the title (read-only) on every line card
- [ ] Switch to table view → Title column is absent
- [ ] Click "Add line" → new line inherits the shared title
- [ ] If title field is required and left blank → "Next" button shows a validation toast
- [ ] Click "Clear form" → shared title resets to blank
- [ ] Submit batch → all submitted expenses have the same title in the DB

---

## 7) Related docs

- [DOC-011 — Batch expense bugs](./batch-expense-bugs.md)
- [DOC-012 — Batch expense review — org custom field columns](./batch-expense-custom-field-columns.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-29 | 1.0 | Agent | Initial implementation |
