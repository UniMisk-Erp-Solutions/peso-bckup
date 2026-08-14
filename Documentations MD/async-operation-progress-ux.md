# DOC-055 — Async Operation Progress UX

**Branch:** `feature/user-activity-insights`
**Status:** complete
**Date:** 2026-07-14

---

## Summary

Adds consistent, anti-flicker progress feedback for every long-running async operation in PesoWise. Operations that take more than 300 ms now show a labelled progress bar; fast operations (< 300 ms) show nothing. A minimum 500 ms visibility prevents flash-disappear. Success auto-clears after 1 800 ms.

---

## Shared infrastructure

### `src/hooks/useOperationProgress.ts`

| Method | Purpose |
|--------|---------|
| `startOperation(phase, opts?)` | Begins an operation — shows the bar after 300 ms anti-flicker delay |
| `updateOperation(phase, opts?)` | Updates label / step count during a running operation |
| `completeOperation(phase)` | Shows success state; auto-clears to idle after 1 800 ms |
| `warnOperation(phase, opts?)` | Shows amber warning (partial success — e.g. draft fallback) |
| `failOperation(phase, errorMessage)` | Shows destructive error state |
| `resetOperation()` | Instantly resets to idle (call before re-submitting) |

`OperationProgressState` fields: `status`, `phase`, `description`, `currentStep`, `totalSteps`, `completed`, `total`, `errorMessage`.

Anti-flicker timers are cleaned up on unmount via `useEffect` return.

### `src/components/AsyncOperationProgress.tsx`

| Prop | Type | Description |
|------|------|-------------|
| `status` | `OperationStatus` | Controls which branch renders |
| `title` | `string?` | Bold label above the bar |
| `description` | `string?` | Muted hint text below the label |
| `value` | `number?` | Explicit 0–100 progress (overrides count calculation) |
| `completed` / `total` | `number?` | Derives `value = completed/total * 100` |
| `currentStep` / `totalSteps` | `number?` | Step-based progress (e.g. 2 of 4 stages) |
| `showSuccess` | `boolean` | Show the green checkmark success state |
| `onRetry` / `retryLabel` | `() => void` / `string?` | Optional retry button on error/warning |
| `compact` | `boolean` | Slim 0.5 px bar + spinning icon (for background refresh overlays) |
| `sticky` | `boolean` | `position: sticky; bottom: 0` for bottom-of-page usage |

Uses the existing `src/components/ui/progress.tsx` (Radix). No new packages.

Render branches:
- `idle` → `null`
- `success && !showSuccess` → `null`; `success && showSuccess` → green checkmark row
- `warning` → amber `Alert` with optional Retry
- `error` → destructive `Alert` with optional Retry; `role="alert"` / `aria-live="assertive"`
- `running && compact` → slim indeterminate bar + spinning `Loader2`
- `running && !compact` → full bar + title + description (determinate if `value`/counts available, else asymptotic pseudo-progress 0 → 85 %)

---

## Per-feature integration

### Single expense submit (`src/pages/ExpenseForm.tsx`)

Five staged progress steps for **new** expense; three for **edit/resubmit**:

| Stage | Phase key | Step |
|-------|-----------|------|
| Preparing | `progress.preparing` | 1/4 |
| Saving | `progress.saving` | 2/4 |
| Saving receipts & details | `progress.savingReceipts` | 3/4 |
| Submitting | `progress.submitting` | 4/4 |

Progress starts **only after** all synchronous validation passes (Zod, custom fields, attachments). A receipt-failure draft fallback shows `warning` status (not success) — key: `progress.draftWarning`.

`MobileStickyActionBar` accepts three new props — `progressTitle`, `progressDescription`, `progressStatus` — and renders a `compact` `AsyncOperationProgress` above the button row on mobile.

### Batch expense submit (`src/pages/ExpenseBatchForm.tsx`)

Three stages:

1. `progress.batchValidating` — branch/custom-field spec resolution (step 1/3)
2. `progress.batchSubmitting` — `submitExpenseBatch` API call (step 2/3)
3. `progress.batchComplete` (success) or `progress.batchPartial` (warning — some lines failed)

### Employee expense list (`src/pages/Expenses.tsx` + `MobileExpenseListView.tsx`)

A `useEffect` watches `loadingAllExpenses` + `enrichingExpenses` flags and drives a `useOperationProgress` hook:

- Load starts → `progress.loadAll`
- Base data fetched, enrichment running → `progress.enriching`
- Enrichment done → `completeLoadAll` with count (`progress.loadedCount`)

`MobileExpenseListView` accepts `loadAllProgressStatus`, `loadAllProgressTitle`, `loadAllProgressDescription` and renders `AsyncOperationProgress` above the load-all button.

### Admin panel (`src/pages/AdminPanel.tsx` + `MobileAdminExpensesView.tsx`)

- Load-all: same `useEffect` pattern as Expenses.
- Bulk approve/reject: `startBulkOp` before the loop, `updateBulkOp(current)` inside each iteration, `completeBulkOp` / `failBulkOp` after. Shows `progress.bulkApproving` / `progress.bulkRejecting` with live `current of total` label.

`MobileAdminExpensesView` accepts six new props: three for load-all progress, three for bulk progress.

### Manager review queue (`src/pages/EngineerReview.tsx`)

Same load-all pattern as Expenses/Admin. No bulk-action loop progress needed (individual approve/reject, not a loop in the same function).

---

## Locale keys added

All keys live under `"progress"` in each locale file:

**`src/locales/{en,hi,gu}/expenses.json`** — inside `"progress"`:
`preparing`, `preparingHint`, `saving`, `savingHint`, `savingReceipts`, `savingReceiptsHint`, `submitting`, `submittingHint`, `complete`, `editComplete`, `draftWarning`, `draftWarningHint`, `receiptProgress`, `loadingExpenses`, `loadingExpensesHint`, `refreshingExpenses`, `loadAll`, `loadedCount`, `enriching`, `enrichingHint`, `retry`, `batchValidating`, `batchValidatingHint`, `batchCreating`, `batchSubmitting`, `batchSubmittingLine`, `batchFinalizing`, `batchComplete`, `batchPartial`, `batchPartialHint`

**`src/locales/{en,hi,gu}/admin.json`** — inside `"panel.progress"`:
`loadingExpenses`, `loadingExpensesHint`, `loadAll`, `loadedCount`, `enriching`, `enrichingHint`, `refreshing`, `bulkApproving`, `bulkRejecting`, `bulkComplete`, `bulkSummary`, `retry`, `loadFailed`, `loadFailedHint`

Same keys also added to `"review.progress"` in admin locale (used by EngineerReview).

---

## Safety invariants preserved

- No SQL, no migrations, no RLS changes.
- No expense workflow or status changes.
- No receipt-finalization or approval permission changes.
- `isSavingRef` / `isSubmittingRef` duplicate-submission guards preserved.
- `Promise.allSettled` for concurrent receipt + field saves preserved (not converted to sequential).
- Existing expense list cache behaviour untouched.
- Progress starts only after all validation passes — validation errors never show a progress bar.
