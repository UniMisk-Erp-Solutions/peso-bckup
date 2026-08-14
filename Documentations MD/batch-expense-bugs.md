# Batch Expense Bugs — Duplicate Submission & Visibility

**Doc ID:** DOC-011
**Status:** in progress
**Last updated:** 2026-06-26
**Owner / area:** Batch Expenses, Role Access, RLS

---

## 1) Summary

Two critical batch expense bugs fixed:

1. **Duplicate line items on submit** — submitting a batch expense created each line 2–3× due to
   concurrent `handleSubmit` calls during the async validation prep loop.
2. **Batch expenses not visible** — employees were blocked at the route level from viewing their
   own submitted batches; team leaders and executives were blocked by the `expense_batches` RLS
   policy (which only granted SELECT to the submitter, admin, or `assigned_engineer_id`).

---

## 2) Problem / requirement

### Duplicate submissions

`ExpenseBatchForm.tsx` `handleSubmit` called `setLoading(true)` at line 458 — AFTER a `for`
loop (lines 406–455) that awaited `ExpenseService.fetchOptionBranchesForCategory` twice per
line. During those 1–3 s round-trips, `loading` was `false` and the submit button was enabled.
Rapid/double clicks fired multiple concurrent `handleSubmit` coroutines, each independently
calling `submitExpenseBatch`, creating the same line items N times.

### Employee can't see own batch

`App.tsx` wired the batch review route with
`allowedRoles={["admin", ...EXPENSE_REVIEW_ROLES]}` and `EXPENSE_REVIEW_ROLES` excludes
`"employee"`. So employees who submitted a batch hit a `ProtectedRoute` redirect before they
could ever reach the page — even though the `expense_batches` RLS correctly allows the
submitter (`user_id = auth.uid()`) to SELECT.

`BatchExpenseReview.tsx` role mapping also returned `null` for employees, triggering the
"unable to open" fallback UI.

### Team leader / executive can't see batches they need to review

`supabase/migrations/20260513160000_expense_batches.sql` grants SELECT on `expense_batches` to:
- `user_id = auth.uid()` (submitter)
- admin org member
- `assigned_engineer_id = auth.uid()`

It does NOT include `assigned_reviewer_id = auth.uid()`. So once a batch progresses past the
engineer tier and the hierarchy reviewer (`team_leader`/`executive`) is assigned via
`assigned_reviewer_id`, they cannot read the `expense_batches` row. The query returns `null`
even though they ARE allowed to see the individual `expenses` rows.

---

## 3) Solution

### Duplicate submission guard

- Added `isSubmittingRef = useRef(false)` in `ExpenseBatchForm`.
- At the start of `handleSubmit` (after sync validation but before the async loop): check and
  set the ref, AND call `setLoading(true)` — so the button is disabled immediately.
- Moved `setLoading(true)` from inside the `try` block to before the async loop.
- The validation early-return path inside the loop now explicitly resets
  `isSubmittingRef.current = false` and `setLoading(false)` before returning, since those
  code paths skip the `finally` block.
- `finally` block resets `isSubmittingRef.current = false` + `setLoading(false)`.

### Employee access to own batches

- `App.tsx`: added `"employee"` to the batch review route's `allowedRoles`.
- `BatchExpenseReview.tsx`: added `"employee"` to the role mapping (returns `"employee"` role).
- `batchExpenseReview.ts`: `actionsForExpenseByRole` returns `[]` for `"employee"` — no review
  actions are available.
- `BatchExpenseReviewPanel.tsx`: when `role === "employee"`, hides the checkboxes (header +
  per-row), the per-row Edit button, and the entire Actions card. The employee sees a clean
  read-only table of their submitted expenses with status badges only.

### Team leader / executive RLS workaround (frontend-only, no DB change)

- `BatchExpenseReviewPanel.tsx` `loadBatch`: if the `expense_batches` query returns `null` (RLS
  blocked), immediately falls back to querying `expenses` filtered by `batch_id +
  organization_id` (reviewers CAN see individual expenses assigned to them).
- If any expenses are found, constructs a synthetic `BatchExpenseReviewBatchInfo` object:
  `label=null`, `shared_category` from first expense's category, `shared_expense_date` from
  first expense's `trip_start`, `line_count` = count of probe rows, `total_amount` = sum.
- The rest of `loadBatch` (profile fetch, corrections, expense rows) proceeds normally using
  `effectiveBatchRow` instead of the original `batchRow`.

---

## 4) Key files

```
src/pages/ExpenseBatchForm.tsx          (isSubmittingRef guard + setLoading moved before async loop)
src/lib/batchExpenseReview.ts           (BatchReviewRole type adds "employee"; actionsForExpenseByRole returns [] for employee)
src/pages/BatchExpenseReview.tsx        (role mapping: employee → "employee")
src/App.tsx                             (batch review route: allowedRoles adds "employee")
src/components/BatchExpenseReviewPanel.tsx  (RLS fallback in loadBatch; employee read-only view)
```

---

## 5) Database / migrations

None. The RLS gap on `expense_batches` (missing `assigned_reviewer_id` check) is worked around
at the frontend by probing the `expenses` table instead. A proper fix would be a migration
adding `OR EXISTS (SELECT 1 FROM expenses WHERE batch_id = expense_batches.id AND
assigned_reviewer_id = auth.uid())` to the SELECT policy.

---

## 6) Test plan

- [ ] **Duplicate guard**: Open batch form, fill 2 lines, click Submit rapidly 3 times → only
      one batch created in the database. Button should become disabled immediately on first click.
- [ ] **Employee view**: Log in as employee who submitted a batch → navigate to
      `/expenses/batch/:id/review` → batch and expenses list visible; no checkboxes, no Edit
      buttons, no Verify/Approve/Reject card.
- [ ] **Engineer review**: Engineer navigates to a batch → checkboxes, Edit, and action buttons
      all visible as before.
- [ ] **Team leader / executive review**: Log in as team_leader who has expenses assigned to
      them in a batch → batch review page loads (synthetic batch info constructed from expenses).
      Verify/approve/reject actions visible and functional.

---

## 7) Related docs

- DOC-002: [`admin-hierarchy-approval-bypass.md`](./admin-hierarchy-approval-bypass.md) — hierarchy approval flow
- DOC-009: [`mobile-upload-and-pwa-stability-fixes.md`](./mobile-upload-and-pwa-stability-fixes.md) — parallel submit optimizations

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-26 | 1.0 | Agent | Initial fix — duplicate submission guard; employee batch visibility; team_leader/executive RLS fallback. |
