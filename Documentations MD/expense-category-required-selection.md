# DOC-051 — Expense Category: Required Explicit Selection

**Status:** complete  
**Branch:** `main` (cherry-picked to `feature/user-activity-insights`)  
**Date:** 2026-07-14  
**Author:** Agent

---

## Summary

New single expenses were automatically pre-selecting "Other" as the category. This commit removes that automatic default so the form begins with no category selected, makes category explicitly required before submission, and carries the same rule into batch expense lines.

---

## Previous Behavior (Bug)

| Location | Bug |
|---|---|
| `ExpenseForm.tsx` initial `expense` state | `category: "other"` |
| `ExpenseForm.tsx` `formStateRef.current` initial value | `category: "other"` |
| `ExpenseForm.tsx` `createDefaultExpenseState()` | `category: "other"` |
| `ExpenseForm.tsx` edit-mode fallback | `category: expenseData.category \|\| "other"` |
| `ExpenseForm.tsx` Clear-form handler | Called `fetchCategoryFormFields("other")` after reset |
| `ExpenseForm.tsx` Zod schema | `category: z.string().optional()` — allowed blank to pass |
| `ExpenseForm.tsx` submit validation | Category required only when `categoryCfg.is_required` is true in org config |
| `expenseBatchValidation.ts` `validateBatchLines` | Category required only when `categoryCfg.is_required` is true in org config |

---

## New Behavior

- New expense form opens with `category: ""` — the picker shows "Select a category".
- The Zod schema validates category as `min(1)` — an empty string fails schema parsing before any service call.
- The submit handler also checks category unconditionally (defence-in-depth): if blank, throws the localized `form.validation.categoryRequired` message.
- The category validation is **not** gated on `categoryCfg.is_visible` or `categoryCfg.is_required` — category is always required for submission regardless of base-field config.
- "Other" remains available as a normal selectable category; manually choosing it passes validation exactly like any other category.
- Clear form resets `category` to `""` and no longer auto-fetches "Other" form fields.
- Edit mode: `expenseData.category || ""` (was `|| "other"`). An old expense that has "Other" still loads "Other". An old expense with no category loads blank; the user must choose before resubmitting.
- Batch lines: `categoryRequired = true` regardless of base-field config. Error message: `"Line N: Category is required"`.
- Existing drafts stored with `category: "other"` (auto-selected) are preserved as-is. The user can use Clear Form to start fresh.

---

## Files Changed

| File | Change |
|---|---|
| `src/pages/ExpenseForm.tsx` | 6 changes: schema required, 3× default `""`, clear-form call removed, edit fallback `""`, submit guard unconditional |
| `src/lib/expenseBatchValidation.ts` | `categoryRequired = true` always (was conditional on base-field config) |
| `src/locales/en/expenses.json` | Added `form.validation.categoryRequired` |
| `src/locales/hi/expenses.json` | Added `form.validation.categoryRequired` |
| `src/locales/gu/expenses.json` | Added `form.validation.categoryRequired` |
| `Documentations MD/expense-category-required-selection.md` | This document |
| `Documentations MD/index.md` | DOC-051 entry + revision log |

---

## SQL Changed

**No.** Pure frontend change. No migrations, no new tables, no RPC changes.

---

## i18n Keys Added

| Namespace key | EN | HI | GU |
|---|---|---|---|
| `expenses:form.validation.categoryRequired` | "Please select a category." | "कृपया एक श्रेणी चुनें।" | "કૃપા કરીને એક શ્રેણી પસંદ કરો." |

---

## Rollout

1. Fix committed to `main` and pushed → Vercel auto-deploys.
2. Same commit cherry-picked to `feature/user-activity-insights` and pushed.
3. No manual SQL or deploy step required.
4. Transfer Offer Login Popup, User Activity Insights, and DPDP work on the feature branch remain intact.

---

## Manual Test Checklist

- [ ] Open New Expense → category picker shows "Select a category" (not "other")
- [ ] Enter amount, fill other fields, click Submit without selecting a category → error toast "Please select a category."
- [ ] `ExpenseService.createExpense` is NOT called (no new expense row created)
- [ ] Select a normal category (e.g. "Travel") → submit succeeds
- [ ] Create another expense, manually choose "Other" → submit succeeds
- [ ] Click "Clear form" → category resets to "Select a category", no "Other" fields appear
- [ ] Edit an existing expense that has "Other" → form loads with "Other" pre-selected (not changed)
- [ ] Edit an existing expense that has "Travel" → form loads with "Travel" pre-selected (not changed)
- [ ] Open Batch Expense, fill a line without category → batch submit shows "Line 1: Category is required"
- [ ] Manually choose "Other" for a batch line → batch submits successfully
- [ ] Verify category picker shows all available categories including "Other" (not removed)
- [ ] Test in Hindi / Gujarati locale → error message appears in the correct language

---

## Rollback Notes

All changes are pure frontend (5 source files + 2 locale files).

```bash
git revert <commit-hash>
git push origin main
git push origin feature/user-activity-insights
```

No SQL to revert. No stored data is affected. Existing "Other" expense records continue to display "Other".
