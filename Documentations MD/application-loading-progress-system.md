# DOC-056 — Application-Wide Loading Progress System

**Status:** complete  
**Branch:** `feature/user-activity-insights`  
**Last updated:** 2026-07-14  
**Related:** DOC-055 (Async Operation Progress UX — foundational hook + component)

---

## Summary

Every authenticated page and key component in PesoWise now surfaces consistent async-loading feedback via the shared `useOperationProgress` hook and `AsyncOperationProgress` component (introduced in DOC-055). This document covers the full rollout across all pages and components wired in DOC-056.

**What changed:** 15 files across pages and components gained progress bars with anti-flicker delay (300 ms show-delay, 500 ms min-visible, 1800 ms success auto-clear). No SQL, no migrations, no RLS changes.

---

## Pages and components wired

### Wired in the previous session (committed in `2d65cb0`)

| Page/Component | Loading state(s) wired | Progress mode |
|---|---|---|
| `Balances.tsx` | `loading` (profiles), `transferHistoryLoading`, bulk-add operation | Full (page guard) + compact (history tab) + determinate (bulk) |
| `MobileBalancesView.tsx` | same via props | Full + compact |
| `CashTransferHistory.tsx` | `loading` | Compact overlay |
| `Notifications.tsx` | `loading` | Compact + spinner |
| `CashierTransactions.tsx` | `loading` (shared across two tabs) | Compact |
| `AccountantApprovedExpenses.tsx` | `loading` | Compact in card |
| `TransferOffers.tsx` | `loading` | Compact above tabs |
| `UserManagement.tsx` | `listLoading`, bulk import with `onProgress` callback | Compact (list) + determinate (bulk import) |
| `Analytics.tsx` | `loading` | Full (page guard replaced) |
| `Dashboard.tsx` | `loading` | Compact inline next to subtitle |
| `UserActivityInsights.tsx` | React Query `isLoading` | Full (main table) + compact (dialog) |

### Wired in this session (committed in `9979361`)

| Page/Component | Loading state(s) wired | Progress mode |
|---|---|---|
| `MyTeams.tsx` | page-level `loading`, `TeamExpensesPanel` per-team `loading` | Full (team list) + compact (expenses panel) |
| `Settings.tsx` | `loading` (initial settings load), `saving` (admin settings save) | Compact in admin card |
| `CategoryManagement.tsx` | `loading` (category list) | Full (page guard) |
| `BatchExpenseReviewPanel.tsx` | `loading` (batch load guard), `actionLoading` (approve/verify/reject) | Full (load guard) + compact (action bar) |
| `TransferOfferPromptGate.tsx` | `loading` (accept/reject action) | Compact above action buttons |

---

## Pattern used in every file

```tsx
// 1. Import
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

// 2. Hook — inside the component
const { progress, startOperation, completeOperation } = useOperationProgress();
const prevLoadingRef = useRef(false);

// 3. useEffect — transition detector
useEffect(() => {
  const wasLoading = prevLoadingRef.current;
  prevLoadingRef.current = loading;
  if (loading && !wasLoading) {
    startOperation("Loading…", { description: "hint text" });
  } else if (!loading && wasLoading) {
    completeOperation("Loaded");
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [loading]);

// 4a. Full progress bar — replaces page guard spinner
if (loading) {
  return (
    <AsyncOperationProgress
      status={progress.status !== "idle" ? progress.status : "running"}
      title={progress.phase || "Loading…"}
    />
  );
}

// 4b. Compact overlay — shown alongside existing content
{progress.status !== "idle" && (
  <AsyncOperationProgress
    status={progress.status}
    title={progress.phase}
    showSuccess={progress.status === "success"}
    compact
  />
)}
```

**Exception — React Query (`UserActivityInsights.tsx`):** No `useEffect` needed. `isLoading` from React Query is a boolean; pass `status="running"` hardcoded when `isLoading` is true.

**Exception — determinate operations (bulk import/add in `UserManagement.tsx`, `Balances.tsx`):** Use `updateOperation({ completed, total })` inside the `onProgress` callback to drive a determinate progress bar.

---

## `useOperationProgress` hook reference

Source: `src/hooks/useOperationProgress.ts`

| Method | Signature | Effect |
|---|---|---|
| `startOperation` | `(title, opts?)` | Sets `status: "running"`, starts 300 ms anti-flicker delay before showing |
| `updateOperation` | `(opts: { completed, total, phase? })` | Updates determinate progress while running |
| `completeOperation` | `(successMsg?)` | Sets `status: "success"`, auto-clears after 1800 ms |
| `failOperation` | `(errorMsg?)` | Sets `status: "error"` |
| `warnOperation` | `(warnMsg?)` | Sets `status: "warning"` |
| `resetOperation` | `()` | Returns to `status: "idle"` immediately |

`progress` object returned:
```ts
{
  status: "idle" | "running" | "success" | "warning" | "error";
  phase: string;       // current title/label
  completed?: number;  // for determinate bars
  total?: number;
}
```

---

## `AsyncOperationProgress` component reference

Source: `src/components/AsyncOperationProgress.tsx`

Key props:

| Prop | Type | Description |
|---|---|---|
| `status` | `OperationStatus` | Controls visual state |
| `title` | `string` | Main label |
| `description` | `string?` | Sub-label (only for full/non-compact mode) |
| `compact` | `boolean?` | Slim bar + icon; use for overlays inside cards |
| `completed` | `number?` | Filled progress (determinate) |
| `total` | `number?` | Total for determinate bar |
| `showSuccess` | `boolean?` | Show green tick and success message |
| `onRetry` | `() => void?` | Show retry button on `status: "error"` |

---

## Locale keys added for Balances

`src/locales/{en,hi,gu}/balances.json` — `progress` namespace:

```json
"progress": {
  "loadingProfiles": "Loading balances…",
  "loadingProfilesHint": "Fetching employee profiles and roles",
  "profilesReady": "{{count}} users loaded",
  "loadingHistory": "Loading transfer history…",
  "loadingHistoryHint": "Fetching recent cash transfers",
  "historyReady": "Transfer history loaded",
  "bulkAdding": "Adding {{current}} of {{total}}…",
  "bulkComplete": "Bulk transfer complete",
  "bulkPartial": "{{succeeded}} of {{total}} users updated",
  "retry": "Retry"
}
```

---

## All Expenses loading UX correction (follow-up, 2026-07-14)

Fixed several regressions and gaps in `AdminPanel.tsx` and `MobileAdminExpensesView.tsx` identified post-rollout:

### Problems fixed

| # | Problem | Fix |
|---|---|---|
| A | Raw translation keys shown (`panel.progress.loadAll` etc.) | All `t("panel.progress.*")` calls replaced with `t("admin:review.progress.*")` |
| B | Large blank white spinner (`min-h-[400px]`) during initial load | Replaced with `AsyncOperationProgress` using `expenseFetchProgress` state |
| C | Load All shows no real loaded/total progress | `updateLoadAll()` called inside `runOrgExpenseQuery` pagination loop with `{ completed: rows.length, total: count }` |
| D | Mobile has plain spinner-only loading state | Replaced with `AsyncOperationProgress`; spinner only fires when no rows yet and fetch not yet complete |
| E | `useOperationProgress` anti-flicker timer restarts on every `updateOperation` | Fixed: `showTimerPendingRef` flag ensures only ONE show timer per operation; `internalRef` gives timer callback latest state |
| F | Boolean-only effect drove Load All progress | Removed — progress now driven from real data inside fetch loop |
| G | On error, expenses were cleared | `fetchExpenses` now preserves existing rows on error; sets `expenseFetchError` |
| H | Load All button showed untranslated text | Button now uses `admin:review.progress.loadAllButton` / `loadingButton` with counts |

### New state added to `AdminPanel.tsx`

- `hasCompletedExpenseFetch: boolean` — gates empty-state and ensures spinner only shows on true initial load
- `expenseFetchError: string | null` — tracks last fetch error for retry affordance
- `expenseFetchProgress` hook — for initial/refresh fetch progress
- `loadAllProgress` hook updated with `failLoadAll` and `resetLoadAll`

### New locale keys added (`admin:review.progress.*`)

Keys added across EN/HI/GU in `src/locales/{en,hi,gu}/admin.json`:
`loadingExpenses`, `loadingExpensesHint`, `refreshing`, `refreshingHint`, `loadAll`, `loadAllHint`, `loadedCount`, `enriching`, `enrichingHint`, `updated`, `bulkApproving`, `bulkRejecting`, `bulkComplete`, `bulkSummary`, `retry`, `loadFailed`, `loadFailedHint`, `loadAllButton`, `loadingButton`

### New props added to `MobileAdminExpensesView`

`expenseFetchProgressStatus`, `expenseFetchProgressTitle`, `expenseFetchProgressDescription`, `hasCompletedExpenseFetch`, `loadAllProgressCompleted`, `loadAllProgressTotal`

---

## What is NOT included in DOC-056

- `useOperationProgress` hook and `AsyncOperationProgress` component themselves — see **DOC-055**
- Expense submit / batch submit / load-all / admin bulk actions — see **DOC-055**
- SQL, migrations, RLS — none in this feature

---

## Files changed

```
src/pages/MyTeams.tsx
src/pages/Settings.tsx
src/pages/CategoryManagement.tsx
src/pages/Balances.tsx
src/pages/CashTransferHistory.tsx
src/pages/Notifications.tsx
src/pages/CashierTransactions.tsx
src/pages/AccountantApprovedExpenses.tsx
src/pages/TransferOffers.tsx
src/pages/UserManagement.tsx
src/pages/Analytics.tsx
src/pages/Dashboard.tsx
src/pages/UserActivityInsights.tsx
src/components/BatchExpenseReviewPanel.tsx
src/components/TransferOfferPromptGate.tsx
src/components/mobile/MobileBalancesView.tsx
src/locales/en/balances.json
src/locales/hi/balances.json
src/locales/gu/balances.json
```

**Additional files changed in All Expenses loading UX correction:**

```
src/pages/AdminPanel.tsx
src/components/mobile/MobileAdminExpensesView.tsx
src/hooks/useOperationProgress.ts
src/locales/en/admin.json
src/locales/hi/admin.json
src/locales/gu/admin.json
```

## Pass 12 additions (2026-07-15)

`AsyncOperationProgress` adopted in two more components:

- `src/components/BatchExpenseDetailCard.tsx` — replaced `Loader2` spinner with `status="running"`, added `status="error"` with `onRetry`
- `src/components/ExpenseFormFieldsDisplay.tsx` — replaced `Loader2` spinner and `Alert`+`RefreshCw` error with `AsyncOperationProgress` loading and error states

New i18n keys added in `src/locales/*/expenses.json` under `fieldDisplay.*` and `batchReview.*`.
