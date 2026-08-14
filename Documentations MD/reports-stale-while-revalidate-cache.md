# DOC-054 — Reports: Stale-While-Revalidate Live Cache

**Status:** complete  
**Date:** 2026-07-14  
**Branch:** `feature/user-activity-insights`  
**SQL changed:** No  
**Migration required:** No

---

## Problem (previous blocking behavior)

All four report tabs shared a single `loading` boolean state. When any report fetch started:

- **Verification & Approval**: the entire report area was replaced by a centred `"Loading…"` div — all previously loaded rows vanished.
- **Detailed Expense Report**: the table body was replaced by a single `"Loading…"` table row, clearing all visible data.
- **Daily Project Report**: an absolute overlay (`bg-background/60`) was placed over the table, obscuring cached rows while a new fetch ran. On mobile the whole card list was replaced by `"Generating report…"`.

Returning to the `/admin/reports` route triggered fresh fetches with no memory of the previous result. Filter changes or manual Submit always blanked the report before new data arrived.

---

## Solution: Stale-While-Revalidate via React Query

### In-memory cache only

Report data is cached exclusively in React Query's **in-memory store** — no localStorage, sessionStorage, IndexedDB, or service-worker cache is used. The cache survives route changes within the running app but resets on a full page reload. This is intentional: financial and employee data must never be persisted to browser storage.

### Pure async loaders

Four module-level loader functions replace the old inline fetch methods:

| Loader | Returns |
|---|---|
| `loadVerificationReport(params)` | `Promise<ExpenseWithUser[]>` |
| `loadApprovalReport(params)` | `Promise<ExpenseWithUser[]>` |
| `loadDetailedReport(params)` | `Promise<{ expenses, allocations }>` |
| `loadDailyReport(params)` | `Promise<DailyProjectExpenseReportBuildResult[]>` |

Each loader fetches all enrichment data (profiles, custom fields, batch metadata, allocations) before returning, so the report is replaced atomically. A failed fetch throws — React Query keeps the previous cached result and marks the query as errored.

### Query key isolation (`src/lib/reportQueryKeys.ts`)

Every dimension that affects report results is encoded in the query key:

```
["reports", orgId, scopeKey, reportType, ...filterParams]
```

- `orgId` — caches never mix between organizations
- `scopeKey` — `"org"` for admin view, `"team:<sorted-ids>"` for team-scoped reports
- `reportType` — `"verification"` | `"approval"` | `"detailed"` | `"daily"`
- Filter params — employee, category, status, year, month, week, period mode, date range, config signature

Sorting team member IDs before building `scopeKey` ensures the key is deterministic regardless of fetch order.

### Query settings

```typescript
staleTime: 0                  // always stale → always refetch in background on tab switch
gcTime: 30 * 60 * 1000       // keep unused cache for 30 minutes
placeholderData: keepPreviousData  // show previous key's data while new key fetches
refetchOnMount: "always"      // refetch every time the tab becomes active
refetchOnWindowFocus: true    // refetch on window focus
refetchOnReconnect: true      // refetch after reconnect
retry: 1                      // one retry on failure before marking error
```

### Tab-conditioned `enabled` flag

Each query is enabled only when its tab is active:

```typescript
enabled: activeTab === "verification" && Boolean(organizationId) && canViewReports && teamScopeReady
```

When the user switches back to a previously visited tab:
1. `enabled` changes from `false` → `true`
2. React Query detects stale cached data and immediately starts a background fetch
3. The cached result is shown instantly while the fresh fetch runs

---

## ReportLiveRefreshBar (`src/components/ReportLiveRefreshBar.tsx`)

A slim non-blocking component placed above each report's content. Handles four states:

### 1. Initial loading (no cached data)
```
Loading report…
Fetching live expenses for the selected filters.
[progress bar]
```
The report area is empty — no misleading "No expenses found" message is shown prematurely.

### 2. Background refresh (cached data exists)
```
↻  Fetching live expenses…  ·  Showing the last loaded report while the latest expenses are fetched.
[thin 2px progress bar]
```
The full report remains visible underneath.

### 3. Success
```
✓  Report updated  ·  Last updated 14:32
```
Shown for 2.5 seconds, then clears.

### 4. Refresh failed (cached data exists)
```
⚠  Could not refresh the live report.  Showing the last successfully loaded report.  [Retry]
```
Amber non-blocking alert. The report remains fully visible. Retry calls `query.refetch()`.

### Progress bar behavior
- Internal pseudo-progress (0 → 85%, asymptotic approach) — never displays a real percentage
- `role="status"`, `aria-live="polite"` for screen readers
- `motion-reduce:transition-none` for reduced-motion users
- `h-1.5` on initial load, `h-0.5` on background refresh

---

## Export safety

While any report is fetching, its Export button is disabled:

```tsx
disabled={query.isFetching || data.length === 0}
title={query.isFetching ? t("liveRefresh.exportWait") : undefined}
```

After a failed refresh, cached data remains visible and export stays disabled until the user retries and the next fetch succeeds.

Export formats (XLSX, CSV, JSON, PDF), file names, headers, and generation logic are unchanged.

---

## Live expense invalidation (realtime)

A single Supabase realtime channel is subscribed per mounted Reports component:

```typescript
supabase.channel(`reports-rt-${organizationId}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "expenses",
      filter: `organization_id=eq.${organizationId}` }, handler)
  .subscribe()
```

On any INSERT/UPDATE/DELETE:
- A 1000 ms debounce timer fires
- `queryClient.invalidateQueries({ queryKey: ["reports", organizationId] })` is called
- React Query refetches all active report queries in the background
- Cached rows remain visible — no blank flash

**Debouncing** prevents a storm when multiple rows change together.

The channel is removed on unmount. Only one channel is open regardless of which tab is active.

---

## Failure behavior

| Scenario | Behavior |
|---|---|
| First load fails (no cache) | Amber RefreshBar (no data to show) + Retry |
| Background refresh fails (cache exists) | Cache shown, amber bar with Retry |
| Error cleared on retry | Normal background-refresh state |
| Network disconnect | Cached data shown; reconnect triggers refetch |

Errors never clear previously successful report arrays.

---

## Mobile behavior

- RefreshBar placed above cards on all four tabs
- Card lists remain visible during background refresh
- No full-screen loader
- Daily: card list shows initial loading state (null) while `dailyQuery.isLoading`; otherwise shows cached cards plus thin RefreshBar
- No horizontal overflow introduced

---

## Files created

| File | Purpose |
|---|---|
| `src/lib/reportQueryKeys.ts` | Deterministic query key builders |
| `src/components/ReportLiveRefreshBar.tsx` | Non-blocking refresh status bar |
| `Documentations MD/reports-stale-while-revalidate-cache.md` | This document |

## Files changed

| File | Change |
|---|---|
| `src/pages/Reports.tsx` | Full refactor: pure loaders, 4 useQuery hooks, realtime sub, JSX updates |
| `src/locales/en/reports.json` | Added `liveRefresh.*` keys |
| `src/locales/hi/reports.json` | Added `liveRefresh.*` keys (Hindi) |
| `src/locales/gu/reports.json` | Added `liveRefresh.*` keys (Gujarati) |
| `Documentations MD/index.md` | DOC-054 entry added |

---

## Manual testing checklist

- [ ] Open `/admin/reports` — Verification tab loads with progress bar, no "No expenses" prematurely
- [ ] Leave Reports, return — cached rows appear instantly, thin bar shows "Fetching live expenses…"
- [ ] Rows remain fully visible during background refresh
- [ ] Switch to Approval tab — loads or shows cached data
- [ ] Switch to Detailed tab, select an employee — shows expenses + allocations consistently
- [ ] Switch to Daily tab (if enabled) — config loads, report fetches, no overlay
- [ ] Submit button on each tab forces an immediate refetch
- [ ] Change employee filter — previous employee's rows visible until new data arrives
- [ ] Disconnect network — cached rows remain, amber bar with Retry
- [ ] Reconnect, click Retry — report refreshes
- [ ] Export button disabled while refresh is running
- [ ] Open `/team-reports` — scoped data loads correctly, team scope key is correct
- [ ] Verify mobile: cards visible during refresh, no full-screen loader
- [ ] Submit expense in another session — report refreshes within ~1 s (realtime)

---

## Rollback notes

All changes are pure frontend. To revert:

1. `git revert <commit-hash>` on the commit containing this change
2. No SQL rollback needed
3. No migration rollback needed
4. React Query cache is in-memory and resets on page reload — no cleanup needed

The revert restores the old `loading` state + manual fetch effects.
