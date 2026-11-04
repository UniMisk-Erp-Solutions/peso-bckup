# Review attachment state race

**Doc ID:** DOC-159  
**Status:** in progress  
**Last updated:** 2026-10-26  
**Owner / area:** Admin review, Review Expenses  

---

## 1) Summary

A reviewer who opened one expense and then another could briefly see the first expense's receipt. The database and storage links were already correct. The review screen applied a slow network response after the selection had moved on. AdminPanel and the live Review Expenses screen now ignore that late response, clear the previous expense immediately, and keep the receipt preview on the expense that opened it.

---

## 2) Problem / requirement

Incident class: stale review UI after a fast expense switch.

A reviewer opened Expense B, then Expense A. Each expense has its own attachments. The server returned the correct list and the correct file addresses for both. For a moment the screen still showed Expense B's bill on Expense A.

That rules out a bad attachment row, a shared file, a soft-deleted bill, and a browser cache swap between two different addresses. The failure was frontend state: the request for the first expense finished after the second expense was already selected, and the screen stored that result anyway. The previous receipt also stayed on screen until the new request finished, so there was no loading state in between.

The same pattern existed for line items, the audit timeline, and reviewer corrections.

---

## 3) Solution

- A monotonic request ticket. Only the newest request for the expense on screen may write.
- The write also checks that the response's expense is still the selected expense. Closing the review invalidates the ticket.
- Attachments are loaded by `useExpenseAttachments`. On the render where the selection changes, the previous rows are already gone and the status is loading. One load per selected expense, plus an explicit reload after a correction is saved.
- The receipt preview is owned by `useExpensePreview`. Switching expense closes it and clears the address on that same render. Switching receipts inside one expense still works.
- An attachment row whose `expense_id` belongs to another expense is not rendered. The console warning uses 8-character prefixes only.
- AdminPanel clears the audit timeline and correction list during render, before a queued response can land, and shows loading or a per-expense error.
- Review Expenses clears line items, the timeline, and corrections when the expense id changes, shows loading, and on failure shows that expense's error instead of the previous expense's rows. Closing the review, including after a bulk action, invalidates the in-flight detail request.

No receipt address is cache-busted. No approval, balance, upload, or ownership rule changed.

---

## 4) Key files

```
src/lib/latestRequestGuard.ts
src/lib/expenseAttachmentIdentity.ts
src/hooks/useExpenseAttachments.ts
src/hooks/useExpensePreview.ts
src/pages/AdminPanel.tsx
src/pages/EngineerReview.tsx
src/features/reviewExpensesServer/ReviewExpenseDetail.tsx
supabase/migrations/20261101100000_review_detail_v2_active_attachments_ordered.sql
```

---

## 5) Database / migrations

Prepared only. Do not apply until a separate approval.

`supabase/migrations/20261101100000_review_detail_v2_active_attachments_ordered.sql`

`get_review_expense_detail_v2` attachments subquery:

- `deleted_at IS NULL`
- `ORDER BY created_at, id`

Nothing else in the function body changes. No screen calls this function today. Production was not modified.

---

## 6) Test plan

Automated:

- Slow A / fast B, fast A / slow B, rapid A/B/A/B
- Preview reset on expense change, and preview switching inside one expense
- Failure of A after a switch to B, and failure of B with no fallback to A
- Close while a request is in flight
- Attachment row whose expense id does not match
- Audit, correction, and line-item writes check the active expense
- One attachment load per selected expense
- Migration text differs only in the attachments subquery

Manual, on local or QA data, never on the two production expenses from the incident:

- [ ] Expense A with 4 receipts, Expense B with 4 different receipts
- [ ] Open A, preview one receipt, switch to B immediately. Repeat 10 times. B's receipts only, preview closed, loading shown, no flash of A's image
- [ ] A → B → A → B several times. The screen always ends on the last expense
- [ ] Close the review while receipts are still loading. It stays closed
- [ ] Confirm the migration file is not applied

---

## 7) Known limitations

- Manual QA on a running review screen is still required before merge.
- The prepared SQL function is not live. Soft-deleted rows stay possible in that unused function until the migration is applied on purpose.
- Receipt bytes are still cached by the browser under their own address. That is expected. Two different addresses are not substituted for each other.

---

## 8) Related docs

- [Removed attachments reappearing](./removed-attachments-reappearing-incident.md) for `deleted_at` on attachment rows

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-10-26 | 1.0 | Cursor Grok | Race fix verified with regression tests. Migration prepared, not applied. Not merged. |
