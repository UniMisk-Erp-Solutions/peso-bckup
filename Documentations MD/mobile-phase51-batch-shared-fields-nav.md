# DOC-030 — Mobile UI Phase 5.1: Batch Shared Fields + Batch Review Navigation Repair

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/components/BatchExpenseReviewPanel.tsx`, `src/components/mobile/MobileTopBar.tsx`, `src/pages/ExpenseBatchForm.tsx`, `src/components/mobile/__tests__/MobileBatchPhase51.test.tsx` *(new)*

---

## Summary

Two corrective fixes for the mobile Batch flow:

**A. Batch Shared Fields section labels** — Mobile Batch Create/Edit step 2 now clearly labels `ask_once_per_batch` custom fields under a "Batch Information" heading and per-line expense cards under an "Individual Expenses" heading.

**B. Batch Review navigation repair** — Mobile Batch Review no longer auto-opens a line detail when arriving from the Reviewer Queue. The first view is always the Batch Overview (summary card + line list). `MobileTopBar` back navigation respects the `?from=review` query param: back from batch overview returns to `/review` (Reviewer Queue) instead of always going to `/expenses`.

---

## 1. Problems Fixed

| # | Problem | Fix |
|---|---------|-----|
| 1 | Auto-open: arriving at `/expenses/batch/:id/review?from=review&expense=:id` on mobile immediately opened the line detail, skipping the Batch Overview | `BatchExpenseReviewPanel.tsx`: `isMobileRef` pattern; `setOpenDetailId` skipped when `isMobileRef.current=true` |
| 2 | MobileTopBar back from batch review always went to `/expenses` even when the user arrived from Reviewer Queue (`?from=review`) | `MobileTopBar.tsx`: `getBackTarget` accepts `search` param; returns `/review` when `from=review` |
| 3 | Mobile Batch Form step 2 had no visual distinction between shared (batch-once) and per-line custom fields | `ExpenseBatchForm.tsx`: "Batch Information" label before `BatchSharedCategoryFields`; "Individual Expenses" label before per-line cards |

---

## 2. Architecture

### A. Auto-open fix — `BatchExpenseReviewPanel.tsx`

`loadBatch()` is a `useCallback` with deps `[batchId, organizationId]`. Adding `isMobile` to deps would cause unnecessary re-fetches on viewport resize. Instead, a ref pattern is used:

```tsx
const isMobileRef = useRef(isMobile);
isMobileRef.current = isMobile;
```

Inside `loadBatch`, the auto-open condition guards on `!isMobileRef.current`:

```tsx
// Before fix:
if (highlightExpenseIdRef.current && mapped.some(...)) {
  setOpenDetailId(highlightExpenseIdRef.current);
}

// After fix:
if (!isMobileRef.current && highlightExpenseIdRef.current && mapped.some(...)) {
  setOpenDetailId(highlightExpenseIdRef.current);
}
```

Desktop behavior unchanged. On mobile, `openDetailId` starts null → `MobileBatchReviewView` is the first view.

### B. MobileTopBar back navigation — `MobileTopBar.tsx`

`getBackTarget` now accepts a `search: string` parameter and parses it for `from=review`:

```tsx
function getBackTarget(pathname: string, search: string): string | null {
  ...
  if (/^\/expenses\/batch\/[^/]+\/review$/.test(pathname)) {
    const params = new URLSearchParams(search);
    return params.get("from") === "review" ? "/review" : "/expenses";
  }
  ...
}

// call site:
const backTarget = getBackTarget(location.pathname, location.search);
```

All other routes unaffected. No `from=admin` special-casing needed (admin arrivals → `/expenses` is correct).

### C. Mobile Batch Form section labels — `ExpenseBatchForm.tsx`

Two additions inside the step 2 `<CardContent>`:

1. **"Batch Information" header** — shown on mobile when at least one line has a category (i.e., `uniqueCategoriesInLines(lines).length > 0`), before `BatchSharedCategoryFields`. `BatchSharedCategoryFields` self-hides when no `ask_once_per_batch` fields exist for a category, so the header appears only when relevant.

2. **"Individual Expenses" header** — shown on mobile inside the ternary's cards branch (else branch), before `lines.map(...)`. Desktop table branch is unaffected.

```tsx
// Batch Information label (before BatchSharedCategoryFields)
{isMobile && uniqueCategoriesInLines(lines).length > 0 && (
  <div className="space-y-0.5 pt-1">
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      Batch Information
    </p>
    <p className="text-xs text-muted-foreground">
      These fields apply to all lines in this batch
    </p>
  </div>
)}

// Individual Expenses label (before lines.map in cards branch)
{isMobile && (
  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
    Individual Expenses
  </p>
)}
```

---

## 3. Navigation flow after fix

```
Reviewer Queue (/review)
  └─ tap batch expense card
       → navigate("/expenses/batch/:id/review?from=review&expense=:expenseId")
       → BatchExpenseReviewPanel loads
       → isMobileRef.current=true → highlightExpenseId is IGNORED
       → renders MobileBatchReviewView (Batch Overview)

Batch Overview
  └─ MobileTopBar back (ChevronLeft) → navigate("/review")    ← from=review respected
  └─ tap a line card → setOpenDetailId(exp.id) → MobileBatchLineDetail

Line Detail
  └─ in-component Back button → setOpenDetailId(null) → Batch Overview
  └─ MobileTopBar back (ChevronLeft) → navigate("/review")    ← URL unchanged, same topbar target
```

---

## 4. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries in mobile components | ✓ |
| No new packages | ✓ |
| No DB migrations | ✓ |
| No commit / push / deploy | ✓ |
| Desktop batch review layout unchanged at ≥768px | ✓ — `isMobileRef.current=false` → auto-open still works on desktop |
| Desktop batch form unchanged | ✓ — "Batch Information" / "Individual Expenses" labels only rendered when `isMobile=true` |
| Phase 4 reviewer queue unmodified | ✓ — `EngineerReview.tsx` navigation unchanged; the panel now correctly ignores `?expense=` on mobile |
| `loadBatch` dep array unchanged | ✓ — `isMobileRef` avoids adding `isMobile` to deps |

---

## 5. Changes to existing files

### `BatchExpenseReviewPanel.tsx`
- Add `const isMobileRef = useRef(isMobile); isMobileRef.current = isMobile;` (2 lines, after `highlightExpenseIdRef`)
- Change auto-open condition: prepend `!isMobileRef.current &&`

### `MobileTopBar.tsx`
- `getBackTarget(pathname)` → `getBackTarget(pathname, search)`
- Batch review case: parse `URLSearchParams(search)` → return `/review` when `from=review`
- Call site: `getBackTarget(location.pathname, location.search)`

### `ExpenseBatchForm.tsx`
- Before `{organizationId && uniqueCategoriesInLines(lines).map(...)}: add "Batch Information" label block (mobile-only)
- Cards ternary else branch: wrap `lines.map(...)` in `<>...</>` fragment; add "Individual Expenses" label before the map

---

## 6. New test file

`src/components/mobile/__tests__/MobileBatchPhase51.test.tsx` — 17 tests

| # | Group | Coverage |
|---|-------|----------|
| T1 | splitAssignmentsByBatchMode | `ask_once_per_batch=true` → batchOnce |
| T2 | splitAssignmentsByBatchMode | `ask_once_per_batch=false` → perLine |
| T3 | splitAssignmentsByBatchMode | undefined → perLine |
| T4 | splitAssignmentsByBatchMode | `show_on_submit=false` → excluded from both |
| T5 | splitAssignmentsByBatchMode | mixed fields correctly split |
| T6 | applyBatchFieldsToLines | merges batch fields into matching-category line |
| T7 | applyBatchFieldsToLines | line unchanged when no batch fields for category |
| T8 | uniqueCategoriesInLines | returns unique non-blank categories |
| T9 | MobileTopBar | batch review + `?from=review` → navigates to `/review` |
| T10 | MobileTopBar | batch review + no `from` → navigates to `/expenses` |
| T11 | MobileTopBar | `/review` URL → no back button |
| T12 | MobileBatchReviewView | renders batch label |
| T13 | MobileBatchReviewView | renders submitter name |
| T14 | MobileBatchReviewView | one card per expense |
| T15 | MobileBatchReviewView | onSelectExpense fires with correct expense |
| T16 | MobileBatchReviewView | no table element; uses `.mobile-batch-line-card` |
| T17 | MobileBatchReviewView | empty state message |

---

## 7. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **441 / 441 pass** (17 new + 424 prior) |
| `npm run migrations:check` | No new migrations |

---

## 8. NO COMMIT / NO PUSH / NO DEPLOY
