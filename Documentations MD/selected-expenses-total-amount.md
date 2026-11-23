# Selected expenses total amount (All Expenses bulk bar)

**Doc ID:** DOC-166  
**Status:** in progress  
**Last updated:** 2026-11-23  
**Owner / area:** Admin Panel, All Expenses

---

## 1) Summary

On the admin **All Expenses** page, the blue bulk-selection bar ("N expense(s) selected") now also shows the **total amount of all selected expenses**, so an approver sees the money being approved or rejected before using Bulk Approve / Bulk Reject.

---

## 2) Problem / requirement

The bar only showed the count of selected expenses. Admins wanted the combined rupee amount of the selection next to the count.

---

## 3) Solution

`selectedTotalAmount` sums `total_amount` of every expense whose id is in `selectedExpenseIds` (looked up in the full `expenses` list, so it stays correct across pages). It is displayed as `Total: ₹…` using the existing `formatINR` helper, beside the count. Frontend only; no change to selection, approve or reject logic.

---

## 4) Key files

```
src/pages/AdminPanel.tsx
```

---

## 5) Database / migrations

None.

---

## 6) Test plan

- [ ] Select one expense: total equals that expense's amount.
- [ ] Select several (including "select all"): total equals the sum of the Amount column of the selected rows.
- [ ] Untick a row: total decreases; clear selection: bar disappears.
- [ ] Bulk Approve / Bulk Reject still work as before.

---

## 7) Related docs

- [DOC-080 bulk approve](./index.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-23 | 1.0 | Claude Code | Initial: selected total shown in bulk bar |
