# DOC-032 — Mobile UI Phase 6B: Cashier Operations + Notifications

**Status:** complete
**Last updated:** 2026-07-01
**Tests after this phase:** 474 total (18 new)

---

## Overview

Phase 6B completes the mobile experience for cashier-role users and the notifications screen.
Six controller pages each received an `isMobile` early-return branch that renders a dedicated
mobile component in place of the desktop table/form layout. All data flows through existing
controller state passed as props — **no new Supabase queries** were introduced.

---

## Files changed

### New mobile components

| File | Purpose |
|------|---------|
| `src/components/mobile/MobileNotificationsView.tsx` | Notification card list with sticky mark-all-read header |
| `src/components/mobile/MobileTransferOffersView.tsx` | Two-tab (Pending / History) offer cards; reuses `TransferOfferActions` + `TransferOfferStatusBadge` |
| `src/components/mobile/MobileAccountantExpensesView.tsx` | Stats grid, search+sort bar, approved-expense cards for accountant-cashier |
| `src/components/mobile/MobileCashierTransactionsView.tsx` | Two-tab (Assignments / Returns) card list for cashier money assignments + returns |
| `src/components/mobile/MobileCashTransferHistoryView.tsx` | Search + transfer-history card list |
| `src/components/mobile/MobileBalancesView.tsx` | Three-tab (Balances / Offers / History) cashier balance-management screen |

### Modified controllers (isMobile branch added)

| File | Change |
|------|--------|
| `src/pages/AccountantApprovedExpenses.tsx` | Imports + `useViewportMode` + isMobile early return |
| `src/pages/Notifications.tsx` | Imports + `useViewportMode` + isMobile early return |
| `src/pages/TransferOffers.tsx` | Imports + `useViewportMode` + isMobile early return |
| `src/pages/CashierTransactions.tsx` | Imports + `useViewportMode` + isMobile early return |
| `src/pages/CashTransferHistory.tsx` | Imports + `useViewportMode` + isMobile early return |
| `src/pages/Balances.tsx` | Imports + `useViewportMode` + isMobile early return |

### Tests

`src/components/mobile/__tests__/MobileCashierPhase6B.test.tsx` — 18 tests (T1–T18):
- T1–T3: `MobileNotificationsView` (renders title, empty state, mark-all-read callback)
- T4–T6: `MobileTransferOffersView` (renders amount, empty state, history tab trigger)
- T7–T9: `MobileAccountantExpensesView` (renders user name, empty state, onViewExpense callback)
- T10–T12: `MobileCashierTransactionsView` (renders recipient name, empty state, returns tab trigger)
- T13–T15: `MobileCashTransferHistoryView` (renders amount, empty state, setSearchTerm callback)
- T16–T18: `MobileBalancesView` (renders user name, balances empty state, history empty state)

---

## Architecture rules (preserved from Phase 6A)

- **No new Supabase queries in mobile components.** Every component receives its data as props from the existing controller.
- **`isMobile` branch pattern** — `const { isMobile } = useViewportMode()` is inserted after all hooks; an early return before the desktop JSX renders the mobile component.
- **`useViewportMode`** uses `useSyncExternalStore` and returns `{ isMobile }` when viewport ≤ 767 px.
- **Desktop path is unchanged** — the early return is inserted before the existing `return (...)`, so desktop rendering is unaffected.

---

## Component details

### MobileNotificationsView

- Sticky header: page title + unread badge + "Mark all read" button (visible when `unreadCount > 0`)
- Card per notification: icon (from `getNotificationIcon` prop), title, message, time ago, badge variant
- Empty state: `data-testid="notifications-empty"`
- Individual card: `data-testid="notification-item"`
- Exports `MobileNotification` interface (structurally identical to the local `Notification` type in `Notifications.tsx`, allowing assignment without a cast)

### MobileTransferOffersView

- Two Radix UI tabs: **Pending** / **History**
- Pending tab: one card per offer showing amount, from/to names, payment mode; delegates actions to `<TransferOfferActions offer={offer} />`
- History tab: same cards but status-badge-only (no action buttons)
- Empty states: `data-testid="transfer-offers-pending-empty"` / `data-testid="transfer-offers-history-empty"`
- Individual card: `data-testid="transfer-offer-card"`

### MobileAccountantExpensesView

- Stats row: "Approved" count tile + "Total Amount" tile
- Search input + sort selector (newest / name A–Z / name Z–A) + custom field filters (`ExpenseCustomFieldFilters`)
- Card per expense: user name, title, amount, trip start date, status badge
- Card CSS class: `mobile-accountant-expense-card`; `data-testid="accountant-expense-card"`
- Empty state: `data-testid="accountant-expenses-empty"`
- Tapping a card calls `onViewExpense(id)` → `navigate("/expenses/:id")`

### MobileCashierTransactionsView

- Two tabs: **Assignments** / **Returns**
- Assignments tab: card per assignment showing recipient name, amount, date, returned badge
- Returns tab: card per return request showing requester name, amount, request date, status
- Card CSS classes: `mobile-cashier-assignment-card`, `mobile-cashier-return-card`
- Empty states: `data-testid="assignments-empty"` / `data-testid="returns-empty"`
- Individual cards: `data-testid="assignment-card"` / `data-testid="return-card"`

### MobileCashTransferHistoryView

- Search input: `data-testid="transfer-history-search"`
- Transfer card: amount, type label (from `getTransferTypeLabel(type)` — 1-param version), from/to names, date, payment mode, notes
- CSS class: `mobile-cash-transfer-card`; `data-testid="transfer-history-card"`
- Empty state: `data-testid="transfer-history-empty"`

### MobileBalancesView

Three tabs:

**Balances tab** — cashier's own balance shown at top when `userRole === "cashier"`. Per-user cards with:
- User name + email + role badge + current balance
- Amount input, note input
- Bank account selector (when `allocationMode === "bank_transfer"` and bank accounts exist)
- "Add Money" / "Transfer" button; disabled when amount ≤ 0 or saving
- Empty state: `data-testid="balances-empty"` / individual card: `data-testid="balance-user-card"`

**Offers tab** — renders `<TransferSentOffersPanel />` (no props; existing component)

**History tab** — search input (`data-testid="balances-history-search"`), transfer cards
- `getTransferTypeLabel` prop is typed `(type: string, transferrerRole?: string, recipientRole?: string) => string` to match `Balances.tsx`'s 3-parameter helper
- Empty state: `data-testid="balances-history-empty"` / individual card: `data-testid="history-transfer-card"`

---

## Key prop type notes

| Component | Tricky prop |
|-----------|-------------|
| `MobileBalancesView` | `getTransferTypeLabel: (type: string, transferrerRole?: string, recipientRole?: string) => string` — 3 params to match `Balances.tsx`; `MobileCashTransferHistoryView` uses the 1-param version from `CashTransferHistory.tsx` |
| `MobileNotificationsView` | `getNotificationIcon: (type: NotificationType) => React.ReactNode` — returns rendered JSX, not a ComponentType |
| `MobileTransferOffersView` | imports `BalanceTransferOffer` from `@/services/BalanceTransferOfferService` |

---

## Test counts by phase

| Phase | Tests added | Cumulative total |
|-------|-------------|-----------------|
| Phase 1 | — | baseline |
| Phase 2 | — | — |
| Phase 2.5 | 15 | 318 |
| Phase 3A | 30 | 348 |
| Phase 3B | 18 | 366 |
| Phase 3B.1 | 0 | 366 |
| Phase 3 Combined | 16 | 382 |
| Phase 4 | 24 | 406 |
| Phase 5 | 18 | 424 |
| Phase 5.1 | 17 | 441 |
| Phase 6A | 15 | 456 |
| **Phase 6B** | **18** | **474** |
