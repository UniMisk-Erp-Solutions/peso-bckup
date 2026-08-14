# DOC-029 — Mobile UI Phase 5: Batch Review Repair + Batch Form

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/pages/BatchExpenseReview.tsx`, `src/components/BatchExpenseReviewPanel.tsx`, `src/pages/ExpenseBatchForm.tsx`, `src/components/mobile/MobileBatchLineCard.tsx` *(new)*, `src/components/mobile/MobileBatchReviewActionBar.tsx` *(new)*, `src/components/mobile/MobileBatchLineDetail.tsx` *(new)*, `src/components/mobile/MobileBatchReviewView.tsx` *(new)*, `src/index.css`, `src/components/mobile/__tests__/MobileBatchReview.test.tsx` *(new)*

---

## Summary

Fixes the broken mobile Batch Review screen and makes the Batch Form tables phone-friendly. Tapping the `/expenses/batch/:id/review` route on a ≤767px device now shows a card-based list instead of a horizontal-scroll desktop table. Tapping a line card opens a full-screen detail with inline correction and action buttons. The Batch Form step 3 review table and the results table are replaced with card lists on mobile.

---

## 1. Problems Fixed

| # | Problem | Fix |
|---|---------|-----|
| 1 | Duplicate navigation — MobileTopBar back arrow + page H1 + Back button | `BatchExpenseReview.tsx`: render H1/Back only when `!isMobile` |
| 2 | Desktop table forced into phone screen (horizontal clip, `min-w-max`) | `BatchExpenseReviewPanel.tsx`: `isMobile` branch returns card list before desktop JSX |
| 3 | Line detail rendered below entire table (detached from row) | `BatchExpenseReviewPanel.tsx`: `isMobile && openDetailId` branch returns full-screen detail |
| 4 | Batch Form step 3 review table unreadable on phone | `ExpenseBatchForm.tsx`: card list when `isMobile` |
| 5 | Batch Form results table unreadable on phone | `ExpenseBatchForm.tsx`: card list when `isMobile` |

---

## 2. Architecture

```
BatchExpenseReview.tsx (page wrapper — controller-aware)
  ├── isMobile=true  → renders BatchExpenseReviewPanel with no H1/back wrapper
  └── isMobile=false → renders BatchExpenseReviewPanel inside desktop page layout

BatchExpenseReviewPanel.tsx (review controller — unchanged logic)
  ├── isMobile=true, openDetailId set → MobileBatchLineDetail (full-screen)
  │     ├── BatchExpenseDetailCard  (existing — owns its own data fetch)
  │     └── MobileBatchReviewActionBar (sticky bottom)
  ├── isMobile=true, no openDetailId → MobileBatchReviewView
  │     └── MobileBatchLineCard (per expense)
  └── isMobile=false → existing desktop JSX (table + BatchExpenseDetailCard + actions card)

ExpenseBatchForm.tsx (form controller — unchanged logic)
  ├── step 2: view toggle hidden on mobile; always renders cards view
  ├── step 3: table → inline card list when isMobile
  └── results: table → inline card list when isMobile
```

**Key invariant:** Mobile components are pure presentation — zero new Supabase queries. `BatchExpenseDetailCard` (existing, with its own queries) is reused directly.

---

## 3. Changes to existing files

### `BatchExpenseReview.tsx`
- Import `useViewportMode`
- Add `const { isMobile } = useViewportMode();`
- Container div: `isMobile ? "pb-4" : "space-y-6 max-w-6xl mx-auto p-4 sm:p-6"`
- H1 + Back button wrapped in `{!isMobile && (...)}`

### `BatchExpenseReviewPanel.tsx`
- Import `useViewportMode`, `MobileBatchReviewView`, `MobileBatchLineDetail`
- Add `const { isMobile } = useViewportMode();` in the hooks section (before conditional returns)
- Mobile detail branch (before desktop return): when `isMobile && openDetailId`, renders `MobileBatchLineDetail` with full correction state + all action callbacks
- Mobile list branch: when `isMobile && !openDetailId`, renders `MobileBatchReviewView`
- `onSelectExpense` callback: `setSelectedIds(new Set([exp.id])); setOpenDetailId(exp.id);`
- `onBack` callback: `setOpenDetailId(null); setSelectedIds(new Set()); setCorrectionDialogOpen(false);`
- Desktop return is completely untouched

### `ExpenseBatchForm.tsx`
- Import `useViewportMode`
- Add `const { isMobile } = useViewportMode();`
- Step 2 view toggle buttons: wrapped in `{!isMobile && (...)}`
- Step 2 line rendering: condition changed from `lineViewMode === "table"` to `!isMobile && lineViewMode === "table"` (forces cards view on mobile)
- Step 3 table: wrapped in `isMobile ? <card list> : <Table>`
- Results table: wrapped in `isMobile ? <card list> : <Table>`

---

## 4. New components

### `MobileBatchLineCard.tsx`

Props: `expense: BatchReviewExpenseRow`, `onSelect: () => void`.

Renders a tappable card (CSS class `mobile-batch-line-card`) with:
- Title (truncated) + amount (tabular-nums, never truncates)
- Category (below title, if present)
- Status badge (`ExpenseStatusWithCorrectionBadge`)
- Transaction number (monospace, if present)
- ChevronRight icon to indicate interactivity

### `MobileBatchReviewView.tsx`

Props: `batch`, `expenses`, `submitterName`, `role`, `onSelectExpense`.

Renders:
- Batch summary card (blue-tinted): label, date, category, submitter name, total, line count, pending count
- Card list of `MobileBatchLineCard`s
- Empty state when `expenses.length === 0`

### `MobileBatchReviewActionBar.tsx`

Props: `actionLoading`, `canVerify`, `canApprove`, `canReject`, `canCorrect`, `correctionOpen`, `onVerify`, `onApprove`, `onReject`, `onCorrect`.

CSS class: `mobile-batch-action-bar` (`position: sticky; bottom: 0` — not `fixed`).

Button layout:
- Correct (only when `canCorrect && !correctionOpen`)
- Reject (red, disabled when `!canReject`)
- Approve (when `canApprove`) OR Verify (when `!canApprove`, disabled when `!canVerify`)
- Loading: spinner row instead of buttons (when `actionLoading` is set)

All buttons: `min-h-[44px]`, `flex-1`.

### `MobileBatchLineDetail.tsx`

Props: expense, organizationId, role, actionLoading, canVerify, canApprove, canReject, all correction state (corrTitle/corrDestination/corrExpenseDate/corrPurpose/corrCategory/corrAmount/corrReason + setters), reviewComment + setter, all callbacks.

Renders:
1. Back button + expense title header row
2. `BatchExpenseDetailCard` (reused as-is — owns its own Supabase queries for line items + attachments)
3. Review comment textarea (when `role !== "employee"`)
4. Inline correction panel (amber-tinted, when `correctionDialogOpen=true`): same fields as desktop dialog (title, destination, date, purpose, category via ExpenseCategorySelect, amount, reason)
5. Sticky `MobileBatchReviewActionBar`

`canCorrect` computed internally: `role !== "employee"`.

---

## 5. Correction flow on mobile

1. "Correct" button in `MobileBatchReviewActionBar` calls `onCorrect` → `openCorrectionDialogForExpense(exp)` in panel (fills `corr*` state, sets `correctionDialogOpen=true`).
2. `correctionDialogOpen=true` reveals inline correction panel in `MobileBatchLineDetail`. Desktop Dialog never renders (mobile branch returns early before it).
3. "Save correction" → `onSubmitCorrection` → `submitCorrection()` (service call, `setCorrectionDialogOpen(false)`, reloads batch).
4. "Cancel" → `onCancelCorrection` → `setCorrectionDialogOpen(false)`.

---

## 6. CSS — index.css

Added inside `@media (max-width: 767px)`:

```css
.mobile-batch-line-card {
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  transition: background 0.15s;
}
.mobile-batch-line-card:active {
  background: hsl(var(--accent));
}

.mobile-batch-action-bar {
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

### MobileBatchReview.test.tsx (new) — 18 tests

| Test # | Describe | Coverage |
|--------|----------|----------|
| T1 | MobileBatchLineCard | Renders title, amount, status |
| T2 | MobileBatchLineCard | onSelect fires on tap |
| T3 | MobileBatchLineCard | Shows category when present |
| T4 | MobileBatchLineCard | Shows transaction number |
| T5 | MobileBatchReviewView | Renders batch label and total |
| T6 | MobileBatchReviewView | One card per expense |
| T7 | MobileBatchReviewView | Empty state |
| T8 | MobileBatchReviewView | onSelectExpense fires with expense |
| T9 | MobileBatchReviewView | Shows pending count |
| T10 | MobileBatchReviewView | No table element; has `.mobile-batch-line-card` |
| T11 | MobileBatchReviewActionBar | Approve visible when canApprove |
| T12 | MobileBatchReviewActionBar | Verify visible when !canApprove |
| T13 | MobileBatchReviewActionBar | Correct hidden when correctionOpen |
| T14 | MobileBatchReviewActionBar | Loading spinner state |
| T15 | MobileBatchReviewActionBar | `.mobile-batch-action-bar` class; no fixed positioning |
| T16 | MobileBatchLineDetail | Renders BatchExpenseDetailCard |
| T17 | MobileBatchLineDetail | Correction panel hidden by default |
| T18 | MobileBatchLineDetail | Correction panel shown when correctionDialogOpen=true |

---

## 8. Files changed

| File | Change |
|------|--------|
| `src/pages/BatchExpenseReview.tsx` | `useViewportMode`; hide H1/back when `isMobile` |
| `src/components/BatchExpenseReviewPanel.tsx` | `useViewportMode`; mobile detail + list branches before desktop return |
| `src/pages/ExpenseBatchForm.tsx` | `useViewportMode`; step 2 toggle hidden; step 2 forces cards; step 3 + results card lists |
| `src/components/mobile/MobileBatchLineCard.tsx` | **New** — tappable line card |
| `src/components/mobile/MobileBatchReviewView.tsx` | **New** — batch summary + card list |
| `src/components/mobile/MobileBatchLineDetail.tsx` | **New** — full-screen line detail + inline correction |
| `src/components/mobile/MobileBatchReviewActionBar.tsx` | **New** — sticky per-line action bar |
| `src/index.css` | Add `.mobile-batch-line-card` + `.mobile-batch-action-bar` |
| `src/components/mobile/__tests__/MobileBatchReview.test.tsx` | **New** — 18 tests |
| `Documentations MD/index.md` | DOC-029 row added; Next ID: DOC-030 |

---

## 9. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **424 / 424 pass** |
| `npm run migrations:check` | No new migrations |

---

## 10. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries in mobile components | ✓ — `BatchExpenseDetailCard` reused (existing queries) |
| No new packages | ✓ |
| No DB migrations | ✓ |
| No commit / push / deploy | ✓ |
| ExpenseService unchanged | ✓ |
| BatchExpenseReviewPanel logic unchanged | ✓ — mobile branch returns early; all state/actions/callbacks passed through |
| ExpenseBatchForm logic unchanged | ✓ — only rendering conditional on `isMobile` |
| Desktop batch review layout unchanged at ≥768px | ✓ — `isMobile=false` → existing returns run |
| Phase 4 reviewer queue preserved | ✓ — batch items from queue route to `/expenses/batch/:id/review` which now has mobile UI |

---

## 11. NO COMMIT / NO PUSH / NO DEPLOY
