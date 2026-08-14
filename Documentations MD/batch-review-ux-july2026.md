# Batch Review UX: Button Color-Coding + State Persistence

**Doc ID:** DOC-043  
**Last updated:** 2026-07-07  
**Status:** complete

---

## Summary

Three UX improvements to the Engineer Review page (`EngineerReview.tsx`):

1. **Batch button color-coding** — "Review batch" button changes color based on how many expenses in the batch the current reviewer has already acted on.
2. **Search term persistence** — searching for an employee name, entering a batch, and pressing Back now restores the search.
3. **Page number + scroll position persistence** — navigating into a batch and pressing Back returns to the exact same page and scroll position.

---

## 1. Batch button color-coding

### Behavior

| State | Color | Condition |
|-------|-------|-----------|
| All done | Grey (`secondary` variant) | Every expense in the batch is `approved`, `verified`, or `rejected` by the current reviewer |
| Partially done | Orange (`bg-orange-500`) | Some expenses are done, some are still pending |
| All pending | Blue (default `primary`) | No expenses in the batch have been acted on yet |

### Implementation

A `useMemo` computes a `Map<batchId, "done" | "partial" | "pending">` from `allExpenses`:

```typescript
const batchActionState = useMemo(() => {
  const map = new Map<string, "done" | "partial" | "pending">();
  const batches = new Map<string, Expense[]>();
  for (const e of allExpenses) {
    if (!e.batch_id) continue;
    const arr = batches.get(e.batch_id) ?? [];
    arr.push(e);
    batches.set(e.batch_id, arr);
  }
  for (const [batchId, expenses] of batches) {
    const pending = expenses.filter((e) => isPendingForCurrentReviewer(e));
    if (pending.length === 0) map.set(batchId, "done");
    else if (pending.length < expenses.length) map.set(batchId, "partial");
    else map.set(batchId, "pending");
  }
  return map;
}, [allExpenses]);
```

The button reads `batchActionState.get(expense.batch_id)` to pick its variant and className.

---

## 2. Search term persistence (sessionStorage)

### Problem

User searches "Ramesh", clicks "Review batch", reviews expenses, presses Back — the search box is cleared.

### Solution

`searchTerm` is initialized lazily from sessionStorage and saved on every change:

```typescript
const [searchTerm, setSearchTerm] = useState<string>(() => {
  return sessionStorage.getItem("er-search") ?? "";
});
useEffect(() => {
  sessionStorage.setItem("er-search", searchTerm);
}, [searchTerm]);
```

The sessionStorage key is `er-search`.

---

## 3. Page + scroll position persistence

### Problem

User is on page 3, scrolled down to expense #5, clicks "Review batch", comes back — the page resets to 1 and scrolls to top.

### Solution

- `currentPage` is saved to sessionStorage (`er-page`) on every change.
- `scrollY` is saved immediately before navigating to the batch (`er-scroll`).
- On return, the page is restored from sessionStorage, then scroll position is restored once the list re-renders.

**Stale-while-revalidate safety:** A `prevUserFiltersKeyRef` tracks the user-driven filter combination (search + status + role + date). The page is only reset to 1 when the user **changes** a filter — not when the background data re-fetches (which would previously reset the page even though the user hadn't changed anything).

```typescript
const prevUserFiltersKeyRef = useRef<string | null>(null);
// In filter useEffect:
const newKey = `${searchTerm}|${statusFilter}|${roleFilter}|${dateRange}`;
if (prevUserFiltersKeyRef.current !== null && prevUserFiltersKeyRef.current !== newKey) {
  setCurrentPage(1); // user changed a filter → reset page
}
prevUserFiltersKeyRef.current = newKey;
```

**Navigation helper:** A `navigateToBatchReview` function saves scroll before navigating:

```typescript
const navigateToBatchReview = (batchId: string) => {
  sessionStorage.setItem("er-scroll", String(window.scrollY));
  navigate(`/review/batch/${batchId}`);
};
```

---

## Key files

```
src/pages/EngineerReview.tsx   — batchActionState useMemo, sessionStorage lazy init,
                                  prevUserFiltersKeyRef, navigateToBatchReview helper,
                                  scroll restoration effects, pageRestoredRef
```

---

## Revision log

| Date | Rev | Notes |
|------|-----|-------|
| 2026-07-07 | 1.0 | Initial — batch button color + search/page/scroll persistence |
