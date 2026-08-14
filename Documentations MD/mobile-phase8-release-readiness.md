# DOC-035 — Mobile UI Phase 8: Final Release Readiness + Detailed Report Coverage

**Last updated:** 2026-07-01  
**Status:** complete  
**Tests:** 511 total (8 new in Phase 8)

---

## What changed

Phase 8 closes the last mobile route gap identified in Phase 7: the Detailed Expense Report tab (`value="detailed"`) inside `Reports.tsx` (and transitively `TeamReports.tsx`). A bonus fix was also applied to the Daily Project Report tab (`value="daily"`), which contains a 23-column table that is likewise unusable on mobile.

No new Supabase queries, services, or mutations were added. All data is read from existing controller state passed as props.

---

## Baseline check results (start of Phase 8)

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | CLEAN (no errors) |
| `npm test -- --run` | 503 tests, all passing |
| `npm run build` | FAILED — CategoryManagement.tsx build error |
| `npm run migrations:check` | Clean (152 .sql files, naming warnings only) |

**Build error found and fixed:**

- **File:** `src/pages/CategoryManagement.tsx` (lines 827, 923)
- **Cause:** Phase 7 edit wrapped `isMobile ? (...) : (...)` in extra `{...}` inside the outer `(...) : (...)` paren — JSX expression `{expr}` is only valid inside JSX element bodies, not inside grouping parentheses.
- **Fix:** Removed the wrapping `{` (line 827) and `}` (line 923).
- **Correct structure:** `) : ( isMobile ? (...) : (...) )}`
- **After fix:** `npx tsc --noEmit` clean, `npm run build` → `✓ built in 18.68s`

---

## Source-verified final route matrix (Phase 8 view)

All 22+ authenticated routes audited across all phases.

| Route | Component | Mobile status | Phase |
|-------|-----------|---------------|-------|
| `/dashboard` | Dashboard.tsx | A — MobileDashboardView (OldMoney via @media) | 2 / 3B.1 |
| `/expenses` | Expenses.tsx | A — MobileExpenseListView | 2 |
| `/expenses/new` | ExpenseForm.tsx | A — MobileExpenseFormLayout + StickyActionBar | 3 |
| `/expenses/:id` | ExpenseForm.tsx | A — MobileExpenseFormLayout | 3 |
| `/expenses/:id/edit` | ExpenseForm.tsx | A — MobileExpenseFormLayout | 3 |
| `/expenses/batch/new` | ExpenseBatchForm.tsx | A — mobile step cards | 5 |
| `/expenses/batch/:id/review` | BatchExpenseReview.tsx | A — MobileBatchReviewPanel | 5 |
| `/review` | EngineerReview.tsx | A — MobileReviewQueue + MobileReviewDetail | 4 |
| `/admin` | → `/admin/expenses` | B — redirect | 6A |
| `/admin/expenses` | AdminPanel.tsx | A — MobileAdminExpensesView | 6A |
| `/admin/users` | UserManagement.tsx | B — `hidden sm:/md:` reduces to 3 visible cols | (native) |
| `/admin/reports` | Reports.tsx | A — verification/approval/detailed/daily all mobile-safe | **7+8** |
| `/admin/categories` | CategoryManagement.tsx | A — mobile card list (build error fixed Phase 8) | **7+8** |
| `/my-teams` | MyTeams.tsx | A — mobile card lists for members + expenses | 7 |
| `/team-reports` | TeamReports.tsx | A — wraps Reports.tsx, inherits all fixes | **7+8** |
| `/settings` | Settings.tsx | A — MobileSettingsView | 6C |
| `/analytics` | Analytics.tsx | B — responsive header (fixed Phase 7) | 7 |
| `/accounts` | AccountantApprovedExpenses.tsx | A — MobileAccountantExpensesView | 6B |
| `/balances` | Balances.tsx | A — MobileBalancesView | 6B |
| `/cashier/transactions` | CashierTransactions.tsx | A — MobileCashierTransactionsView | 6B |
| `/cash-transfer-history` | CashTransferHistory.tsx | A — MobileCashTransferHistoryView | 6B |
| `/transfer-offers` | TransferOffers.tsx | A — MobileTransferOffersView | 6B |
| `/notifications` | Notifications.tsx | A — MobileNotificationsView | 6B |
| `/notification-settings` | NotificationSettings.tsx | B — toggle list, no tables, responsive | (native) |
| `/help` | HelpTutorial.tsx | B — flex-wrap, no tables | (native) |

**Status key:** A = has dedicated mobile branch component; B = natively responsive (no table overflow); D = not in mobile nav.

---

## Section 4: Detailed Expense Report audit

### Problem

The `value="detailed"` tab in `Reports.tsx` (lines 2240–2397 before Phase 8) rendered a Detailed List table with **10–12+ dynamic columns** (plus N custom fields per organization):

- All-employees mode columns: Employee, Bill Date, Title, Type of Expense, Purpose, Destination, Batch, [custom fields...], Credit, Debit, Notes
- Single-employee mode columns: Bill Date, Title, Type of Expense, Purpose, Destination, Batch, [custom fields...], Credit, Debit, Notes, Opening Balance, Closing Balance

This table used `<div className="overflow-x-auto border rounded-lg"><table className="min-w-full text-sm">` — completely unusable on 375px/360px viewports. **Not phone-safe.**

The 2-column Summary table (`value="detailed"` tab, lines 2402–2435) was already mobile-safe and was left unchanged.

### Fix

Created `src/components/mobile/MobileDetailedExpenseReportView.tsx` — a pure presentational component with no hooks and no Supabase queries.

**Props interface:**
```typescript
interface MobileDetailedExpenseReportViewProps {
  showDetailedBalanceColumns: boolean;   // Boolean(selectedUser) — controls mode
  loading: boolean;
  detailedCustomFilterHasNoData: boolean;
  balanceInfo: { opening: number };
  detailedListWithBalances: BalanceRow[];    // single-employee mode data
  detailedAllEmployeesRows: AllEmployeesRow[]; // all-employees mode data
}
```

**All-employees card layout:**
```
[Alice Smith]          [₹12,000]
01-06-2026 · Travel
Flight to Mumbai
```

**Single-employee card layout (with Opening Balance banner above, Closing Balance footer below):**
```
Banner: Opening Balance: ₹3,000

[01-06-2026]           [+₹5,000]
Account credited by Admin · Account Credited
Closing: ₹8,000

Footer: Closing Balance: ₹8,000
```

**States handled:**
- `loading=true` → loading message, no cards
- Single-employee, empty → period-empty or custom-filter-no-data message
- All-employees, empty → filter-hint message

`Reports.tsx` updated: the Detailed List table area is now wrapped in `isMobile ? <MobileDetailedExpenseReportView ... /> : <div className="overflow-x-auto ..."><table>...</table></div>`.

`detailedCustomKeys` is intentionally NOT passed as a prop — custom field columns cannot fit on mobile regardless, and the card shows the most important fields (date, title, category, amount, balance). Users who need custom field data use the desktop view or export.

---

## Section 5: Additional overflow gap fixed (Daily Project Report)

The `value="daily"` tab (Daily Project Report, behind `dailyProjectReportEnabled` feature flag) rendered a 23-column table (`DAILY_PROJECT_REPORT_HEADERS`, all `whitespace-nowrap`) — also unusable on mobile.

**Fix:** Inline mobile branch added directly in `Reports.tsx` (no new component needed — the click handler references `setSelectedDailyReportResult` / `setDailyReportSourceOpen` which are in Reports.tsx scope):

**Daily report card layout:**
```
[01/06/2026]              [Alice Smith]
Project Alpha
```

Tapping a card still opens the `DailyReportSourceExpensesSheet` detail panel. Amber highlight preserved for rows `isDailyReportRowNeedsReview(row) === true`.

---

## Files changed

| File | Change |
|------|--------|
| `src/pages/CategoryManagement.tsx` | Build error fixed (removed `{}` wrapping `isMobile ?` inside `(...)`) |
| `src/pages/Reports.tsx` | Added `MobileDetailedExpenseReportView` import; Detailed List table wrapped in `isMobile` conditional; Daily Project Report table wrapped in inline `isMobile` card branch |
| `src/components/mobile/MobileDetailedExpenseReportView.tsx` | **New** — pure presentational card component for Detailed List |
| `src/components/mobile/__tests__/MobilePhase8DetailedReport.test.tsx` | **New** — 8 tests (T1–T8) against real production component |

---

## Tests added (Phase 8 — 8 new tests)

All in `src/components/mobile/__tests__/MobilePhase8DetailedReport.test.tsx`. These tests import and render the **real production component** `MobileDetailedExpenseReportView` directly — no harness wrappers.

| Test | Description |
|------|-------------|
| T1 | All-employees mode: `detailed-card-list` + `detailed-expense-card` rendered |
| T2 | All-employees mode: `user_name` and `title` visible in card |
| T3 | All-employees mode: empty state message when no rows |
| T4 | Single-employee mode: `opening-balance-banner` rendered |
| T5 | Single-employee mode: `detailed-balance-card` + closing balance line |
| T6 | Single-employee mode: period-empty message when no balance rows |
| T7 | Loading state: loading message shown, `detailed-card-list` suppressed |
| T8 | No `overflow-x-auto` element in mobile card output |

---

## Automated verification results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **CLEAN** — no errors |
| `npm test -- --run` | **511 tests, all passing** (43 test files) |
| `npm run build` | **✓ built in 18.68s** — no errors (chunk size warnings are pre-existing) |
| `npm run migrations:check` | Clean — no pending migrations |
| `git diff --check` | CRLF warnings only (Windows-normalized, no whitespace errors) |

---

## Browser QA status

**Browser preview was NOT available in this session.** The verification above is automated only (TypeScript, unit tests, production build). Manual browser QA is required before deployment.

---

## Manual QA checklist by role

### Employee (5-tab nav: Home · Expenses · + · Settings · More)

| Check | Viewport | How to verify |
|-------|----------|---------------|
| Bottom nav visible, 5 tabs | 375px | Open app on phone / DevTools mobile |
| Expense list cards, no horizontal scroll | 375px | `/expenses` |
| Expense form submits, file upload works | 375px | `/expenses/new` |
| Settings page renders without overflow | 375px | `/settings` |
| More sheet opens, links work | 375px | Tap "More" |

### Admin (5-tab nav: Home · Expenses · + · All Expenses · More)

| Check | Viewport | How to verify |
|-------|----------|---------------|
| All Expenses list shows cards | 375px | `/admin/expenses` |
| Reports — Verification tab: card list, no overflow | 375px | `/admin/reports` → Verification List |
| Reports — Approval tab: card list, no overflow | 375px | `/admin/reports` → Claim Approval List |
| Reports — **Detailed tab**: card list, no overflow | 375px | `/admin/reports` → Detailed Expense Report |
| Reports — Summary table still intact | 375px | `/admin/reports` → Detailed Expense Report → Summary section |
| Reports — Desktop table at 768px | 768px | DevTools resize |
| Categories: card list on phone, table on desktop | 375px / 768px | `/admin/categories` |

### Reviewer / Team Leader / Executive (5-tab nav: Home · Expenses · + · Review · More)

| Check | Viewport | How to verify |
|-------|----------|---------------|
| Review queue cards, no horizontal scroll | 375px | `/review` |
| Team Reports — Detailed tab: card list, no overflow | 375px | More → Team Reports → Detailed Expense Report |
| My Teams: member cards + expense cards | 375px | More → My Teams |

### Operational Cashier

| Check | Viewport | How to verify |
|-------|----------|---------------|
| Cashier transactions list | 375px | `/cashier/transactions` |
| Transfer offers | 375px | `/transfer-offers` |
| Balances list | 375px | `/balances` |

### Accountant/Cashier

| Check | Viewport | How to verify |
|-------|----------|---------------|
| Approved expenses list | 375px | `/accounts` |

---

## Safe test-data guidance

- Use a **staging or development Supabase project** for QA, not production.
- For the Detailed Expense Report, you need at least one approved expense for an employee who has received at least one allocation — otherwise the single-employee mode will show empty state.
- For the All-employees mode, filter by "All employees" (leave the employee selector blank/all) and click Submit.
- Custom form fields (custom column keys) are not shown in mobile cards — this is by design. Verify that the desktop table path still shows custom field columns at ≥768px.

---

## `data-testid` attributes added

| Component | `data-testid` | Purpose |
|-----------|--------------|---------|
| `MobileDetailedExpenseReportView` | `detailed-card-list` | Card list container (both modes) |
| | `opening-balance-banner` | Opening balance row (single-employee only) |
| | `detailed-balance-card` | Individual balance row card (single-employee) |
| | `detailed-expense-card` | Individual expense card (all-employees) |
| `Reports.tsx` (inline daily) | `daily-report-card-list` | Daily report card list container |
| | `daily-report-card` | Individual daily report card |

---

## Architecture notes

- **`showDetailedBalanceColumns = Boolean(selectedUser)`** — controls which render mode the component enters. The same boolean controls the column set in the desktop table.
- **`detailedCustomKeys` not passed** — custom field columns are inherently too wide for 375px. Not a regression — the desktop table path is unchanged.
- **`TeamReports.tsx`** is a thin wrapper `<Reports teamScoped />` — all Reports.tsx fixes apply automatically to `/team-reports`.
- **`MobileDetailedExpenseReportView` is hook-free** — it is a pure presentational component. No `useState`, `useEffect`, `useViewportMode`. The `isMobile ? ... : ...` gate lives in Reports.tsx (which already owns the `useViewportMode` call from Phase 7).

---

## Complete mobile rollout inventory (Phases 1–8)

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
| 7 | Final route sweep: Analytics header, MyTeams cards, CategoryManagement cards, Reports cards (verification + approval tabs) |
| **8** | **CategoryManagement build error fixed; `MobileDetailedExpenseReportView` (Detailed Expense Report); Daily Project Report inline mobile cards; 8 new tests → 511 total** |
