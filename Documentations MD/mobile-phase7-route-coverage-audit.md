# DOC-034 — Mobile UI Phase 7: Final Route Coverage Audit

**Last updated:** 2026-07-01  
**Status:** complete  
**Tests:** 503 total (8 new in Phase 7)

---

## What changed

Phase 7 is the final mobile route-coverage sweep. Every More-sheet-accessible route was audited for desktop-overflow issues. Routes with `overflow-x-auto` tables or fixed-width layouts that cannot fit on a 375px viewport were adapted to render card lists on mobile. No new Supabase queries, services, or mutations were added.

---

## Source-verified route matrix

| Route | Component | Pre-Phase 7 mobile state | Phase 7 action |
|-------|-----------|--------------------------|----------------|
| `/dashboard` | Dashboard.tsx | Safe — MobileDashboardView (Phase 2) | None |
| `/expenses` | Expenses.tsx | Safe — MobileExpenseListView (Phase 2) | None |
| `/expenses/new` | ExpenseForm.tsx | Safe — MobileExpenseFormLayout (Phase 3) | None |
| `/expenses/:id` | ExpenseForm.tsx | Safe — MobileExpenseFormLayout (Phase 3) | None |
| `/review` | EngineerReview.tsx | Safe — MobileReviewQueue + MobileReviewDetail (Phase 4) | None |
| `/review/batch/:id` | BatchExpenseReview.tsx | Safe — MobileBatchReviewPanel (Phase 5) | None |
| `/expenses/batch` | ExpenseBatchForm.tsx | Safe — mobile cards in step 3 (Phase 5) | None |
| `/admin/expenses` | AdminPanel.tsx | Safe — MobileAdminExpensesView (Phase 6A) | None |
| `/admin` | AdminPanel.tsx | Safe — redirect → `/admin/expenses` (Phase 6A) | None |
| `/accounts` | AccountantApprovedExpenses.tsx | Safe — mobile view (Phase 6B) | None |
| `/balances` | Balances.tsx | Safe — mobile view (Phase 6B) | None |
| `/cashier` | CashierTransactions.tsx | Safe — mobile view (Phase 6B) | None |
| `/transfers` | CashTransferHistory.tsx | Safe — mobile view (Phase 6B) | None |
| `/transfer-offers` | TransferOffers.tsx | Safe — mobile view (Phase 6B) | None |
| `/notifications` | Notifications.tsx | Safe — mobile view (Phase 6B) | None |
| `/settings` | Settings.tsx | Safe — MobileSettingsView (Phase 6C) | None |
| `/help` | HelpTutorial.tsx | Safe — flex-wrap, md: classes, no tables | None |
| `/user-management` | UserManagement.tsx | Safe — `hidden sm:/md:` reduces to 3 visible cols | None |
| `/analytics` | Analytics.tsx | Minor — fixed-width header, full-width Select | **Fixed (header layout)** |
| `/my-teams` | MyTeams.tsx | `overflow-x-auto` 6-col members + 5-col expenses tables | **Adapted — mobile cards** |
| `/categories` | CategoryManagement.tsx | `overflow-x-auto table-fixed` 4-col table | **Adapted — mobile cards** |
| `/reports` | Reports.tsx | `overflow-x-auto min-w-full` 17-col tables (2 tabs) | **Adapted — mobile cards** |

---

## Routes unchanged (already safe)

18 routes required no changes. They either already have mobile views from prior phases (6A–6C) or use responsive Tailwind classes (`hidden sm:`, `flex-wrap`, `sm:grid-cols-*`) that adapt naturally to 375px.

---

## Routes adapted in Phase 7 (4 files)

### 1. `src/pages/Analytics.tsx`

**Problem:** Page header used a fixed-width `<div className="flex items-center justify-between">` with a `<Select className="w-[180px]">` — on narrow viewports the Select gets clipped and the title/description run into it.

**Fix:** Responsive flex column + full-width Select trigger on mobile.

```tsx
// Before
<div className="p-6 space-y-6">
  <div className="flex items-center justify-between">
    <h1 className="text-3xl font-bold">
    <Select><SelectTrigger className="w-[180px]">

// After
<div className="px-4 py-4 sm:p-6 space-y-6">
  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
    <h1 className="text-2xl sm:text-3xl font-bold">
    <Select><SelectTrigger className="w-full sm:w-[180px]">
```

No new component needed — inline responsive classes only.

---

### 2. `src/pages/MyTeams.tsx`

**Problem:** `TeamMembersTable` (6 columns: Name, Employee ID, Email, Balance, Pending, Approved) and `TeamExpensesPanel` (5 columns: Employee, Title, Amount, Status, Date) both used `overflow-x-auto` with no column hiding — definite horizontal scroll on 375px.

**Fix:** Added `useViewportMode` to each sub-component. When `isMobile` is true, renders card lists instead of tables.

**Members card layout:**
```
[Alice Smith]                 [₹5,000]
EMP001 · alice@example.com
Pending: 2 (₹1,500)   Approved: 3 (₹4,500)
```

**Expenses card layout:**
```
[Alice Smith]                 [₹12,000]
EMP001
[Flight to Mumbai]            [pending badge]
01/06/2026
```

**`data-testid` attributes:**
- `members-card-list` — container for member cards
- `member-card` — individual member card
- `expenses-card-list` — container for expense cards
- `expense-card` — individual expense card

Desktop table paths unchanged (same JSX, wrapped in `isMobile ? ... : ...`).

---

### 3. `src/pages/CategoryManagement.tsx`

**Problem:** `<div className="overflow-x-auto"><Table className="table-fixed w-full">` with 4 columns (Name 35%, Status 20%, Created 25%, Actions 20%). On ~375px, the Actions column holds two 40px icon buttons at ~68px minimum — causes overflow.

**Fix:** Added `useViewportMode` at component top. When `isMobile`, renders card list.

**Category card layout:**
```
[tag-icon] [Travel]   [Active badge]      [Edit] [Delete]
           01/01/2026
```

Cards are `rounded-md border p-3 flex items-center justify-between` with 44px (h-9 w-9) touch targets on action buttons.

**`data-testid` attributes:**
- `categories-card-list` — container
- `category-card` — individual card

---

### 4. `src/pages/Reports.tsx`

**Problem:** Two tabs — Verification List and Claim Approval List — each rendered a `<div className="overflow-x-auto border rounded-lg"><table className="min-w-full text-sm">` with 17 columns. Completely unusable on mobile.

**Fix:** Added `useViewportMode` at component top (single call, used in both tab renders). The loading and empty-state messages were extracted out of the `<tbody>` and rendered as plain `<div>` messages for both mobile and desktop (eliminating a redundant `colSpan={17}` check in the loading/empty branch). When `isMobile`, renders card list; otherwise renders the original table.

Note on imports: `Reports.tsx` uses `@/contexts/auth-context` (hyphenated), not `@/contexts/AuthContext`.

**Verification card layout:**
```
[Bob Jones]                   [₹8,000]
Hotel Stay · Accommodation
[verified badge]  [Pending HO badge]
01/06/2026                          [eye icon]
```

**Approval card layout:**
```
[Bob Jones]                   [₹8,000]
Hotel Stay · Accommodation
[verified badge]  [approved badge]
01/06/2026                          [eye icon]
```

`navigate(\`/expenses/${exp.id}\`)` used for the View button.

**`data-testid` attributes:**
- `verification-card-list` / `verification-expense-card`
- `approval-card-list` / `approval-expense-card`

---

## Controllers reused (no new queries)

Every adapted page uses `useViewportMode()` as the only new hook. All data fetching, state management, filtering, pagination, and side effects remain in the existing controller — the mobile card view reads from the same `useMemo` / `useState` variables as the desktop table.

---

## Files changed

| File | Change |
|------|--------|
| `src/pages/Analytics.tsx` | Responsive header layout (no new component) |
| `src/pages/MyTeams.tsx` | `useViewportMode` import + hook in 2 sub-components; mobile card lists for members + expenses |
| `src/pages/CategoryManagement.tsx` | `useViewportMode` import + hook; mobile card list for categories |
| `src/pages/Reports.tsx` | `useViewportMode` import + hook; mobile card lists for verification + approval tabs |
| `src/components/mobile/__tests__/MobilePhase7Routes.test.tsx` | **New** — 8 tests (T1–T8) |

---

## Tests added (Phase 7 — 8 new tests)

All in `src/components/mobile/__tests__/MobilePhase7Routes.test.tsx`.

| Test | Description |
|------|-------------|
| T1 | MyTeams: `members-card-list` rendered when `isMobile = true` |
| T2 | MyTeams: `members-desktop-table` rendered when `isMobile = false` |
| T3 | MyTeams: `expenses-card-list` rendered when `isMobile = true` |
| T4 | MyTeams: `expenses-desktop-table` rendered when `isMobile = false` |
| T5 | CategoryManagement: `categories-card-list` rendered when `isMobile = true` |
| T6 | CategoryManagement: `categories-desktop-table` rendered when `isMobile = false` |
| T7 | Reports: `verification-card-list` rendered when `isMobile = true` |
| T8 | Reports: `approval-card-list` rendered when `isMobile = true` |

Strategy: harness components mirror the `isMobile ? cards : table` conditional from the production files; `vi.mock` controls `mockIsMobile` per-test via `beforeEach`.

---

## Known remaining issues / out of scope

- **Reports filter controls** (date pickers, employee/category selects) use `md:grid-cols-3/4` — already responsive; no adaptation needed.
- **Reports "Detailed Expense Report" tab** (daily project report, not the overflow tables) uses a separate custom table component — out of Phase 7 scope.
- **Cashier pages horizontal layout** (balances, transfers) were handled in Phase 6B and are not re-touched here.

---

## Complete mobile rollout inventory (Phases 1–7)

| Phase | Scope |
|-------|-------|
| 1 | `useViewportMode`, `MobileAppShell`, `MobileTopBar`, `MobileBottomNav`, `MobileMoreSheet` |
| 2 | `MobileDashboardView`, `MobileExpenseListView`, `MobileExpenseCard`, `MobileExpenseListFilters` |
| 2.5 | Scroll repair (`position:fixed` shell), admin Review tab, dashboard label clarity |
| 3A | Nav + More sheet audit; reviewer/admin 5-item nav; More sheet sections |
| 3B | Dashboard content parity (admin balance, cashier transfers, engineer CTA, return money) |
| 3B.1 | Desktop dashboard parity on mobile; Old Money `@media` rules; admin Review removed from More |
| 3 Combined | Admin 5-item nav (All Expenses direct tab); `MobileExpenseFormLayout`; `FileUpload` mobile variant |
| 4 | Reviewer queue + detail (`MobileReviewQueue`, `MobileReviewDetail`, `MobileReviewCard`, `MobileCorrectionPanel`) |
| 5 | Batch review repair; `MobileBatchReviewPanel`, `MobileBatchLineCard`, `MobileBatchLineDetail`; batch form step 3 cards |
| 5.1 | Auto-open fix; `?from=review` back nav; "Batch Information" + "Individual Expenses" section labels |
| 6A | Admin panel: `MobileAdminExpensesView`, `MobileAdminExpenseCard`, `MobileAdminExpenseDetail` |
| 6B | Cashier + Accountant + Notifications mobile views (6 pages, 6 components) |
| 6C | Employee 5-tab nav; `MobileSettingsView`; `isMoreActivePath` tabs-aware; More sheet audit |
| **7** | **Final route sweep: Analytics header, MyTeams cards, CategoryManagement cards, Reports cards** |
