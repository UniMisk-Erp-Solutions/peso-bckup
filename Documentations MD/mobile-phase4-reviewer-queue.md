# DOC-028 — Mobile UI Phase 4: Reviewer Queue + Review Detail

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/pages/EngineerReview.tsx`, `src/components/mobile/MobileReviewQueueView.tsx` *(new)*, `src/components/mobile/MobileReviewExpenseCard.tsx` *(new)*, `src/components/mobile/MobileReviewDetailView.tsx` *(new)*, `src/components/mobile/MobileReviewActionBar.tsx` *(new)*, `src/components/mobile/MobileCorrectionFields.tsx` *(new)*, `src/index.css`, `src/components/mobile/__tests__/MobileReview.test.tsx` *(new)*

---

## Summary

Full mobile reviewer workflow for engineer, team_leader, and executive roles. Tapping `/review` on a ≤767px device shows a card-based queue instead of the desktop table. Tapping a card switches to a full-screen detail view. Inline correction fields replace the desktop Dialog. All state, actions, fetching, and permission logic remain exclusively in `EngineerReview.tsx`.

---

## 1. Architecture

```
EngineerReview.tsx (controller — unchanged logic)
  ├── isMobile=true, no selectedExpense → MobileReviewQueueView
  │     └── MobileReviewExpenseCard (per expense)
  ├── isMobile=true, selectedExpense → MobileReviewDetailView
  │     ├── MobileReviewActionBar  (sticky bottom bar)
  │     └── MobileCorrectionFields (inline, shown when correctionDialogOpen=true)
  └── isMobile=false → existing desktop JSX (completely unchanged)
```

**Key invariant:** Mobile components are pure presentation — zero Supabase queries, zero service calls, no cache manipulation. All data flows in as props from the controller.

---

## 2. EngineerReview.tsx changes

### Exports added
- `export interface Expense { ... }` — allows mobile components to import the type without circular deps.

### Imports added
```tsx
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileReviewQueueView } from "@/components/mobile/MobileReviewQueueView";
import { MobileReviewDetailView } from "@/components/mobile/MobileReviewDetailView";
```

### Hook call added
```tsx
const { isMobile } = useViewportMode();
```
Added inside `ManagerReview()`, right before `isHierarchyReviewer`.

### Mobile branch (added after access guard, before desktop return)

When `isMobile=true` and `selectedExpense` is set: renders `MobileReviewDetailView` + `AttachmentPreviewDialog` (same dialog from desktop, now rendered here).

When `isMobile=true` and no `selectedExpense`: renders `MobileReviewQueueView`. The `onSelectExpense` callback handles batch routing (`navigate(...)`) and non-batch opening (`setSelectedExpense` + `fetchExpenseDetails` + `fetchEngineerApprovalLimit`).

`onBack` clears `selectedExpense`, `engineerComment`, `lineItems`, `attachments`, `auditLogs`, `correctionLogs`, `timelineAssignees`, and `correctionDialogOpen`.

**Desktop return is completely untouched.**

---

## 3. New components

### MobileReviewExpenseCard.tsx

Props: `expense`, `isPending`, `formatSubline`, `onSelect`.

Renders a tappable card with:
- Employee name + ID/email subline
- Expense title (truncated)
- Amount (tabular-nums, never truncates)
- Status badge (`ExpenseStatusWithCorrectionBadge`)
- Batch badge (only when `expense.batch_id` is set)
- Resubmitted badge (only when `(expense as any).isResubmitted` is true)
- "Action needed" badge when `isPending`
- Expense date

CSS class: `mobile-review-card` (tappable, border-radius: 12px, touch feedback via `:active`).

### MobileReviewQueueView.tsx

Props: `expenses`, `loading`, `searchTerm`, `setSearchTerm`, `statusFilter`, `setStatusFilter`, `timePeriod`, `setTimePeriod`, `managerFetchWarning`, `isPendingForCurrentReviewer`, `formatSubline`, `onSelectExpense`.

Renders:
- Header: "Review Queue" + expense count
- Warning banner (if `managerFetchWarning` is set)
- Search input (full width)
- Status + time period Select filters in a flex row
- Loading: 3 skeleton cards (`animate-pulse`)
- Empty (no filter): "No expenses assigned to you."
- Empty (with filter): "No expenses match the current filters."
- Card list: one `MobileReviewExpenseCard` per expense

### MobileReviewActionBar.tsx

Props: `expense`, `canApprove`, `canCorrect`, `isActionDisabled`, `reviewLoading`, `correctionOpen`, `onVerify`, `onApprove`, `onReject`, `onCorrect`.

CSS class: `mobile-review-action-bar` (`position: sticky; bottom: 0` inside `.mobile-app-scroll`). Not `position: fixed` — sticks to scroll container, stays above the bottom nav.

Button layout:
- Correct (shown only when `canCorrect && !correctionOpen`)
- Reject (red outline)
- Approve (green solid, when `canApprove`) OR Verify (blue, when `!canApprove`)

All buttons: `min-h-[44px]`, `flex-1`.

When `reviewLoading`: spinner "Processing…" row instead of buttons.

### MobileCorrectionFields.tsx

Inline correction form (replaces the desktop Dialog on mobile). Props: all `corr*` fields + setters, `organizationId`, `loading`, `onSubmit`, `onCancel`.

Renders inside a warm amber-tinted rounded panel. Same fields as the desktop correction Dialog:
- Title, Destination, Date of expense, Purpose, Category (`ExpenseCategorySelect`), Total amount, Admin comment, Reason for correction (audit).

### MobileReviewDetailView.tsx

The full-screen detail page for a selected expense. Props: large set covering the expense, all detail sub-data, all correction state, all callbacks.

Renders (top to bottom):
1. Back button ("Queue") + expense title in header row
2. Employee info card (name, ID/email, balance vs amount)
3. Status + meta badges row
4. Trip details card (destination, purpose, admin comment, `ExpenseFormFieldsDisplay` for custom fields)
5. Line items (if any)
6. Receipts (if any) — each with a "View" button that calls `onPreviewAttachment`
7. Review timeline (`ExpenseReviewTimeline`)
8. Correction audit list (if `correctionLogs.length > 0`)
9. Review comment textarea
10. `MobileCorrectionFields` (inline, only when `correctionDialogOpen=true`)
11. `MobileReviewActionBar` (sticky bottom bar)

---

## 4. Correction flow on mobile

On desktop: "Correct expense" button opens a Dialog at the bottom of the page.

On mobile:
1. "Correct" button in `MobileReviewActionBar` calls `onCorrect` → `openCorrectionDialog()` in EngineerReview (same function: fills `corr*` fields, sets `correctionDialogOpen=true`).
2. `correctionDialogOpen=true` reveals `MobileCorrectionFields` inline in the detail view (no Dialog rendered on mobile since mobile path returns early before the desktop Dialog JSX).
3. "Save correction" → `onSubmitCorrection` → `submitExpenseCorrection()` (same function: calls service, sets `correctionDialogOpen=false`, updates `selectedExpense`, refetches).
4. "Cancel" → `setCorrectionDialogOpen(false)` → fields disappear.

---

## 5. Access control

Access guard in EngineerReview.tsx at line ~1068:
```tsx
if (userRole !== "engineer" && !isHierarchyReviewer) {
  return <AccessDenied />;
}
```
This runs BEFORE the `isMobile` branch. Admin is not in `EXPENSE_REVIEW_ROLES` so admin sees the "Access Denied" message on mobile too (not redirected — existing behavior preserved).

Reviewer roles (engineer, team_leader, executive) see the mobile queue. The Review tab is present in their bottom nav from Phase 3A.

---

## 6. CSS — index.css

Added inside `@media (max-width: 767px)`:

```css
/* Review queue cards */
.mobile-review-card {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  transition: background 0.15s;
}
.mobile-review-card:active {
  background: hsl(var(--accent));
}

/* Sticky review action bar */
.mobile-review-action-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 8px;
  padding: 12px 0;
  background: hsl(var(--background));
  border-top: 1px solid hsl(var(--border));
  z-index: 10;
  padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
}
```

---

## 7. Tests

### MobileReview.test.tsx (new) — 24 tests covering 15 spec requirements

| Test # | Describe | Coverage |
|--------|----------|----------|
| 5 | Queue renders supplied items | Cards render; onSelectExpense fires |
| 6 | Batch indicator | Shows Batch badge ↔ batch_id |
| 7 | Resubmitted indicator | Shows Resubmitted badge ↔ isResubmitted |
| 8 | Queue states | loading (skeleton) / empty / filter-empty / warning banner |
| 9 | Detail fields | Employee name, title, custom-fields, timeline, attachment View |
| 10 | Inline correction | corrTitle/corrDestination pre-filled; shown/hidden on correctionDialogOpen |
| 11 | Callbacks called once | Approve / Reject / Correct / Verify each called exactly once |
| 12 | Comment channel | Review comment textarea present |
| 13 | Action bar positioning | `.mobile-review-action-bar` class, no inline `position:fixed` |
| 14 | No duplicate fetch | `supabase.from` not called during MobileReviewQueueView render |
| 15 | Desktop path unchanged | Queue uses `.mobile-review-card` cards, no `<table>` |

---

## 8. Files changed

| File | Change |
|------|--------|
| `src/pages/EngineerReview.tsx` | Export `Expense` type; add `useViewportMode` import + hook call; add `isMobile` branch before desktop return |
| `src/components/mobile/MobileReviewQueueView.tsx` | **New** — card list with filters |
| `src/components/mobile/MobileReviewExpenseCard.tsx` | **New** — tappable expense card |
| `src/components/mobile/MobileReviewDetailView.tsx` | **New** — full-screen detail + inline correction |
| `src/components/mobile/MobileReviewActionBar.tsx` | **New** — sticky action bar |
| `src/components/mobile/MobileCorrectionFields.tsx` | **New** — inline correction fields |
| `src/index.css` | Add `.mobile-review-card` + `.mobile-review-action-bar` CSS |
| `src/components/mobile/__tests__/MobileReview.test.tsx` | **New** — 24 tests |
| `Documentations MD/index.md` | DOC-028 row added; Next ID: DOC-029 |

---

## 9. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **406 / 406 pass** |
| `npm run migrations:check` | No new migrations |
| `npm run build` | **clean** (pre-existing chunk size warning unrelated) |

---

## 10. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries in mobile components | ✓ |
| No new packages | ✓ |
| No DB migrations | ✓ |
| No commit / push / deploy | ✓ |
| ExpenseService unchanged | ✓ |
| Receipt finalization unchanged | ✓ |
| Approval / review logic unchanged | ✓ |
| Batch form unchanged | ✓ |
| Desktop EngineerReview layout unchanged at ≥768px | ✓ — isMobile=false → existing return runs |
| Admin cannot access review actions on mobile | ✓ — access guard fires before isMobile branch |
| No duplicate review fetch or cache | ✓ — MobileReviewQueueView is purely presentational |
| Correction dialog Desktop still works | ✓ — desktop Dialog renders only on desktop path |

---

## 11. NO COMMIT / NO PUSH / NO DEPLOY
