# DOC-057 — Expense Analytics Dashboard

**Branch:** `feature/user-activity-insights`
**Status:** in progress
**Last updated:** 2026-07-15

---

## Overview

Replaced the old single-page Analytics.tsx with a full Expense Analytics Dashboard. The dashboard provides admins with org-wide spend intelligence and employees with a scoped view of their own expenses.

---

## Files added / changed

| File | Change |
|------|--------|
| `src/pages/Analytics.tsx` | Full rewrite — 4-tab analytics page |
| `src/lib/analytics/expenseAnalytics.ts` | NEW — pure analytics library (all pure functions) |
| `src/lib/analytics/analyticsQueryKeys.ts` | NEW — React Query key factory |
| `src/hooks/useExpenseAnalytics.ts` | NEW — React Query hook + Supabase paginated fetch + realtime |
| `src/components/analytics/AnalyticsFilterBar.tsx` | NEW — full filter bar |
| `src/components/analytics/AnalyticsMetricCard.tsx` | NEW — KPI card with comparison |
| `src/components/analytics/AnalyticsChartCard.tsx` | NEW — chart wrapper with skeleton + collapsible data table |
| `src/components/analytics/AnalyticsTooltip.tsx` | NEW — Recharts custom tooltip + `formatAxisINR` |
| `src/components/analytics/AnalyticsEmptyState.tsx` | NEW — empty state component |
| `src/locales/en/analytics.json` | Full expansion (was 4 keys → 100+ keys) |
| `src/locales/hi/analytics.json` | Full Hindi translation |
| `src/locales/gu/analytics.json` | Full Gujarati translation |
| `src/lib/__tests__/expenseAnalytics.test.ts` | NEW — 73 test cases |

---

## Tabs

### 1. Overview
- 5-card KPI row: Total Spend, Expense Count, Avg Expense, Finalized Approval Rate, Active Submitters
- Expense Activity Over Time (area chart, with optional previous-period overlay)
- Current Workflow Snapshot (donut: pending / approved / rejected)
- Quick Insights panel (auto-derived bullets)

### 2. Spend Analysis
- Spend by Category (horizontal bar chart)
- Category Share (pie chart)
- Category Trend Over Time (line chart, top 5 categories)
- Expense Amount Distribution (histogram, 6 INR buckets)
- Cumulative Spend (area chart)
- Spend by Weekday (bar chart)

### 3. Workflow
- Status Breakdown (horizontal bar by amount, coloured by status class)
- Approval Outcome (donut: approved vs rejected)
- Pending Expense Aging (bar chart, 5 age buckets: 0-2, 3-7, 8-14, 15-30, 30+ days)
- Pending / Approved / Rejected KPI cards

### 4. People & Places
- Top Destinations (horizontal bar)
- Top Employees by Spend (horizontal bar, admin only)
- Highest-Value Expenses table (top 10)

---

## Filter bar

| Filter | Type | Notes |
|--------|------|-------|
| Date preset | Pills | 7d / 30d / 90d / 6m / 12m / Custom |
| Custom date range | Date inputs | Visible only when preset = Custom |
| Compare with previous period | Switch | Overlays prev-period line on trend chart |
| Granularity | Radio dropdown | Auto / Daily / Weekly / Monthly |
| Date basis | Radio dropdown | Expense date (trip_start) / Submitted date (created_at) |
| Status | Multi-select checkbox dropdown | All 9 statuses |
| Category | Multi-select checkbox dropdown | Populated from current result |
| Employee | Single-select with search | Admin only |
| Destination | Single-select with search | Populated from current result |
| Reset | Ghost button | Clears all non-date filters |
| Active chips | Tag row | Each chip removes that filter on click |
| Mobile Sheet | Bottom sheet | All detail filters in a swipe-up panel |

---

## Data layer

### Fetch strategy
- Paginated Supabase fetch, `PAGE_SIZE = 1000`
- First page uses `{ count: "exact" }` to get total
- Subsequent pages fetch without count for performance
- No `expense_line_items` in select — minimal column set only
- All expenses except `draft` are fetched (`.neq("status", "draft")`)

### Data scoping
- Admin: `organization_id = org` only
- Employee / cashier / engineer: `organization_id = org` AND `user_id = self`

### React Query settings
- `staleTime: 0` — always refetch on mount
- `gcTime: 30 minutes` — keep in cache for navigation
- `placeholderData: keepPreviousData` — no blank flicker during filter changes

### Realtime
- One Supabase channel per org (`analytics:orgId`)
- Debounced 1000 ms — prevents thrashing during batch operations
- Invalidates `analyticsKeys.all(orgId)` on any expense INSERT/UPDATE/DELETE

---

## Pure analytics library (`expenseAnalytics.ts`)

All functions are pure — no Supabase, no React, no i18n. Can be tested in isolation.

### Status classification
```
PENDING  = submitted | under_review | level_1_verified | level_2_verified | verified | edited
APPROVED = approved | paid
REJECTED = rejected
DRAFT    = draft (excluded from all analytics)
```

### Approval rate formula
```
finalizedApprovalRate = approvedCount / (approvedCount + rejectedCount)
```
Returns `null` when no finalized decisions exist (shows "—" in UI).

### Key functions

| Function | Purpose |
|----------|---------|
| `classifyExpenseStatus(status)` | Maps status → `pending \| approved \| rejected \| draft \| other` |
| `safeAmount(v)` | Guards null / string / NaN → 0 |
| `computeMedian(amounts[])` | Even/odd-safe median |
| `resolveGranularity(gran, from, to)` | Auto: ≤45d=daily, ≤180d=weekly, else monthly |
| `dateToKey(date, gran)` | Stable ISO bucket keys: `yyyy-MM-dd \| yyyy-Www \| yyyy-MM` |
| `generateBucketKeys(from, to, gran)` | All keys in range (ensures empty buckets appear) |
| `computePreviousPeriod(from, to)` | Equal-length period immediately before |
| `computeKPIs(expenses)` | Totals, averages, pending/approved/rejected splits, approval rate |
| `computeChange(current, prev)` | `pct \| new \| zero \| none` — drives trend arrows |
| `buildTrend(...)` | Array of `DateBucket` with optional prev period overlay |
| `buildCategoryBreakdown(expenses)` | Top 10 categories + "Other categories" rollup |
| `buildCategoryTrend(...)` | Top 5 categories over time as wide rows |
| `buildStatusBreakdown(expenses)` | Per-status count + amount, sorted by status order |
| `buildDestinationBreakdown(expenses)` | Top 10 destinations, blank → "Unspecified" |
| `buildEmployeeBreakdown(expenses, profiles)` | Top 10 employees by amount (admin only) |
| `buildPendingAging(expenses, now)` | 5 buckets: 0-2, 3-7, 8-14, 15-30, 30+ days |
| `buildAmountHistogram(expenses)` | 6 INR range buckets |
| `buildWeekdayBreakdown(expenses, dateBasis)` | Mon–Sun activity |
| `buildCumulativeSpend(trend)` | Running total per bucket |
| `buildQuickInsights(...)` | Auto-generated insight strings (used by UI for i18n) |
| `computeAnalytics(...)` | Master entry point — calls all builders |

---

## i18n

All user-visible strings are in the `analytics` namespace. Keys cover:

- `page.*` — title / description
- `filters.*` — all filter labels and placeholders
- `tabs.*` — tab labels
- `metrics.*` — KPI labels and tooltip hints
- `charts.*` — chart titles and descriptions
- `statuses.*` — localized status names
- `tooltips.*` — recharts tooltip row labels
- `comparison.*` — vs-prev-period labels and change indicators
- `insights.*` — quick insight templates (use `{{variable}}` interpolation)
- `loading.*` — loading states
- `errors.*` — error states
- `empty.*` — empty states
- `export.*` — export button and sheet labels
- `accessibility.*` — screen-reader labels

---

## Tests (`expenseAnalytics.test.ts`)

73 test cases covering all pure functions:

| Suite | Tests |
|-------|-------|
| `safeAmount` | 6 |
| `computeMedian` | 5 |
| `classifyExpenseStatus` | 11 |
| `getExpenseStatusOrder` | 3 |
| `resolveGranularity` | 6 |
| `dateToKey` | 3 |
| `bucketKeyToLabel` | 3 |
| `computePreviousPeriod` | 2 |
| `getExpenseDate` | 4 |
| `computeKPIs` | 6 |
| `computeChange` | 5 |
| `buildCategoryBreakdown` | 4 |
| `buildStatusBreakdown` | 3 |
| `buildDestinationBreakdown` | 2 |
| `buildEmployeeBreakdown` | 2 |
| `buildPendingAging` | 2 |
| `buildAmountHistogram` | 2 |
| `buildWeekdayBreakdown` | 2 |
| `buildCumulativeSpend` | 2 |
| **Total** | **73** |

All pass: `npx vitest run src/lib/__tests__/expenseAnalytics.test.ts`

---

## Design decisions

**No expense_line_items in select.** Previous analytics code selected line items; this version deliberately omits them. Line items are not needed for summary analytics and dramatically increase data transfer for large orgs.

**Stale-while-revalidate on filter change.** `keepPreviousData` ensures charts stay visible (slightly dimmed) while the new period loads. This avoids a full blank-page flash on every filter interaction.

**Realtime with 1 s debounce.** Without debouncing, a batch approval of 50 expenses would trigger 50 immediate refetches. The debounce collapses these into one.

**Approval rate = approved/(approved+rejected).** Pending expenses are in the pipeline, not yet decided. Including them in the denominator would make the rate meaningless for orgs with slow approval cycles.

**Employee breakdown admin-only.** Employees can see their own data, but should not see a breakdown comparing themselves to colleagues. Only admins see the employee tab content.
