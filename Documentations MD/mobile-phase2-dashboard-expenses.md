# DOC-022 — Mobile UI Phase 2: Dashboard + Expense List

**Status:** in progress  
**Last updated:** 2026-07-01  
**Affects:** `src/pages/Dashboard.tsx`, `src/pages/Expenses.tsx`, 4 new mobile components

---

## Summary

Adds phone-first (≤767px) views for the Dashboard and My Expenses pages.
Data is fetched exactly once in the existing route controller; mobile components
receive it via props — no new Supabase queries, no duplicate Realtime channels.

Desktop behaviour at ≥768px is **completely unchanged**.

---

## Files created

| File | Purpose |
|------|---------|
| `src/components/mobile/MobileDashboardView.tsx` | Dashboard view: balance card, 2 stat cards, New Expense CTA, recent notifications, View Expenses link |
| `src/components/mobile/MobileExpenseListView.tsx` | Expense list: search + status filter chips + card list + empty/no-results states + Load All |
| `src/components/mobile/MobileExpenseCard.tsx` | Single expense card — title, destination, amount, date, status badge, Resubmitted/Batch/Category indicators |
| `src/components/mobile/MobileExpenseListFilters.tsx` | Search input + scrollable status filter chips |
| `src/components/mobile/__tests__/MobileExpenseCard.test.tsx` | 7 tests: renders fields, Resubmitted badge logic, Batch badge, category, absent destination |

## Files modified

| File | Change |
|------|--------|
| `src/pages/Dashboard.tsx` | Added `useViewportMode` + `MobileDashboardView` imports; added `const { isMobile } = useViewportMode()` alongside other hooks; added `if (isMobile) return <MobileDashboardView …/>` before the Old Money gate |
| `src/pages/Expenses.tsx` | Added `useViewportMode` + `MobileExpenseListView` + `MobileExpenseItem` imports; added `const { isMobile } = useViewportMode()` after last `useRef`; added `if (isMobile) return <MobileExpenseListView …/>` before main return |

---

## Key architectural decisions

### No data-hook extraction

`Dashboard.tsx` owns state + realtime subscription + cashier return request channel.
Extracting to `useDashboardData` would risk breaking the complex realtime teardown
and the monolithic seq token logic. The prop-passing approach (`stats`, `loading`,
`notifications`, `userRole`, `userBalance` passed as props) achieves the same
single-mount guarantee without moving any logic.

Similarly, `Expenses.tsx` already computes `filteredExpenses` in a single pass;
prop-passing is sufficient.

### Mobile gate placement

```
Dashboard.tsx:
  all hooks → statCards array → [if isMobile] → [if old-money] → loading → main return

Expenses.tsx:
  all hooks → all function declarations → [if isMobile] → main return
```

Both gates are placed **after all hook calls**, satisfying React's Rules of Hooks.

### Theme compatibility

`MobileDashboardView` uses only semantic tokens (`bg-primary`, `text-foreground`,
`bg-card`, `border-border`). The Old Money CSS variable re-skin at the `:root` /
`[data-theme="old-money"]` level applies automatically — no theme-specific branches
needed in mobile components.

The mobile gate in Dashboard.tsx takes priority over the Old Money gate:
- Mobile + any theme → `MobileDashboardView`
- Desktop + Old Money → `OldMoneyDashboard` (unchanged)
- Desktop + Legacy → existing desktop JSX (unchanged)

### Type compatibility

`MobileExpenseItem` (exported from `MobileExpenseCard.tsx`) is a structural superset
of `Expense` (Dashboard local type) — all required fields are satisfied, extra optional
fields (`batch_id`, `category`) are resolved at runtime from the `select("*")` payload
even though they are not declared in the Expenses.tsx interface. No cast needed.

---

## Mobile Dashboard design

| Element | Data source | Notes |
|---------|-------------|-------|
| Balance card | `userBalance ?? stats.currentBalance` | Cashier/engineer/employee use personal balance; admin uses org balance |
| Pending stat | `stats.pendingAmount` | Always shown |
| Second stat | Role-dependent: `pendingReviews` (reviewer), `pendingApprovals` (admin), `approvedAmount` (others) | |
| New Expense CTA | Rendered when `!isAccountantCashier || allowCashierExpenseSubmission` | Mirrors FAB logic |
| Notifications | `notifications` slice (up to 2) | Tap → `/expenses/:id`; "View all" → `/notifications` |
| My Expenses link | — | Always shown; → `/expenses` |
| Loading state | `loading` prop | `DashboardSkeleton` component |
| Updating indicator | `statsRefreshing` prop | Pulse text "updating…" in balance card corner |

No recent expense list — legacy Dashboard does not fetch recent expenses.

---

## Mobile Expense List design

| Element | Behaviour |
|---------|-----------|
| Search | Filters via existing `searchTerm` / `setSearchTerm` — no new query |
| Status chips | `all`, `submitted`, `verified`, `approved`, `rejected` — single-select |
| Card | Title, destination, amount, date (trip_start > created_at), status badge, Resubmitted / Batch / Category |
| Empty (no data) | "No expenses yet" + New Expense button |
| No results | "No results found" + Clear filters button (resets both search + status) |
| Load All | Shown when `!allExpensesLoaded && totalCount > shown` — calls `handleLoadAllExpenses` |
| Enriching indicator | "Updating details…" while `enrichingExpenses === true` |
| Loading skeleton | 5× `Skeleton` cards while `loading === true` |

---

## Verification results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors |
| `npm test -- --run` | 303/303 pass (7 new) |
| `npm run build` | Clean (pre-existing chunk size warnings only) |
| `git diff --check` | CRLF normalisation warnings only |

---

## Phase 2 constraints (not implemented)

- Drafts tab — deferred to Phase 3
- Return Money dialog on mobile — deferred to Phase 3
- Swipe-to-delete / swipe actions — explicitly out of scope
- Old Money mobile dashboard — mobile uses `MobileDashboardView` with semantic tokens; no Old Money–specific mobile layout
- Notification badge count on bell — Phase 1 constraint still open
