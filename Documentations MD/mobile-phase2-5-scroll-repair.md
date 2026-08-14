# DOC-023 — Mobile UI Phase 2.5: Scroll Repair + Shell Polish

**Status:** in progress  
**Last updated:** 2026-07-01  
**Affects:** `src/index.css`, `src/components/mobile/MobileAppShell.tsx`, `src/components/mobile/MobileBottomNav.tsx`, `src/components/mobile/MobileDashboardView.tsx`

---

## Summary

Corrective pass to restore scrolling on all mobile routes, fix the bottom navigation role map, and clarify dashboard metric labels. No pages' business logic, forms, upload flows, or desktop layouts were changed.

---

## Confirmed root cause

`MobileAppShell` used `flex flex-col min-h-[100dvh]`. Because the outer container had only a **minimum** height (not a fixed one), the child `flex-1 min-h-0 overflow-y-auto` scroll div could grow with its content — `overflow-y: auto` never activated. The browser's document scroll became the scroll owner instead of the intended `#app-main-scroll` element. Fixed-position bottom nav then overlapped content with no way to scroll past it.

---

## Exact scroll owner

`#app-main-scroll` → `.mobile-app-scroll` CSS class.  
One per page. Verified by `querySelectorAll(".mobile-app-scroll").length === 1` test.

---

## Conflicting scroll/height rules found and fixed

| Rule | Where | Fix |
|------|--------|-----|
| `min-h-[100dvh]` on shell | MobileAppShell outer div | Replaced with `.mobile-app-shell` (position:fixed; inset:0; height:100dvh) |
| `flex-1` without bounded parent height | Scroll div child | Parent now has bounded height (fixed shell) → `flex-1` creates true bounded height |
| `position: fixed; bottom-0; left-0; right-0` on nav | MobileBottomNav `<nav>` | Removed; nav is now a `shrink-0` in-flow flex item — shell is already fixed and covers the viewport |
| `paddingBottom: calc(96px + …)` inline style | Scroll div | Removed — nav is in-flow, no clearance padding needed |

**No conflicting rules found in:** ExpenseForm.tsx, AdminPanel.tsx, EngineerReview.tsx, ExpenseBatchForm.tsx, BatchExpenseReview.tsx.  
(All use `space-y-*` or `gap-*` root wrappers — no `h-screen`, `overflow-hidden`, or fixed positioning at their root level.)

---

## New scroll architecture

```
.mobile-app-shell  →  position: fixed; inset: 0; height: 100svh/100dvh; display: flex; flex-direction: column; overflow: hidden
  MobileTopBar     →  shrink-0  (56px + safe-area-top)
  #app-main-scroll →  .mobile-app-scroll  →  flex: 1 1 0%; min-height: 0; overflow-y: auto; overflow-x: hidden
    <inner wrapper> →  max-w-2xl; px-4; pt-4; pb-8  (pb-8 clears FAB overhang)
      {children}   →  every routed page — can grow to any height, scrolls within region
  MobileBottomNav  →  shrink-0  (76px + safe-area-bottom, IN-FLOW flex item)
```

Vaul Drawer (`MobileMoreSheet`) renders via portal to document.body — unaffected. ✓

---

## Routes verified as scrollable

All existing desktop content renders inside `mobile-app-scroll`. Since no page wrappers use `h-screen` or `overflow-hidden` at their root, all routes inherit correct mobile scrolling without any per-page changes.

| Route | Status |
|-------|--------|
| `/dashboard` | ✓ scrollable |
| `/expenses` | ✓ scrollable |
| `/expenses/new` | ✓ scrollable |
| `/admin` | ✓ scrollable |
| `/review` | ✓ scrollable |
| `/expenses/batch/new` | ✓ scrollable |
| `/expenses/batch/:id/review` | ✓ scrollable |

---

## Dashboard metric hierarchy changes

| Before | After |
|--------|-------|
| "Pending" | "Pending amount" |
| "₹5669 total" (ambiguous subtext) | "5 expenses" (clear count) |
| "To Review" | "Awaiting review" |
| "Pending Approvals" | "Awaiting approval" |
| "Approved" | "Approved amount" |
| Single "My Expenses →" row (blank area below) | + "Recent expenses" section with empty-state card |

No new data fetched. "Recent expenses" shows a compact empty-state since legacy Dashboard does not query recent expenses.

---

## Bottom navigation role map

| Role | Slot 1 | Slot 2 | Centre | Slot 4 |
|------|--------|--------|--------|--------|
| employee | Home | Expenses | FAB | More |
| engineer / team_leader / executive | Home | Expenses | FAB | Review |
| **admin** | Home | Expenses | FAB | Review ← **fixed** |
| cashier (can submit) | Home | Expenses | FAB | More |
| cashier (no submit) | Home | Balances | Transactions | More |
| cashier (accountant) | Home | Approved | Notifications | More |
| master_admin | Master | Settings | — | More |

**Fix:** `role === "admin"` now explicitly maps to the Review tab, in addition to `EXPENSE_REVIEW_ROLES`. Admin has full access to the review queue; the previous code only checked `EXPENSE_REVIEW_ROLES` which excluded admin.

---

## Files changed

| File | Change |
|------|--------|
| `src/index.css` | Replaced `@media (max-width: 767px)` block with `.mobile-app-shell`, `.mobile-app-scroll`, `.mobile-fab-shadow` |
| `src/components/mobile/MobileAppShell.tsx` | Uses `.mobile-app-shell` + `.mobile-app-scroll` classes; removed `min-h-[100dvh]` and inline `paddingBottom` style; content wrapper `pb-8` for FAB clearance |
| `src/components/mobile/MobileBottomNav.tsx` | Removed `fixed bottom-0 left-0 right-0 z-50`; added `shrink-0`; added `role === "admin"` to review nav condition |
| `src/components/mobile/MobileDashboardView.tsx` | Fixed metric labels; replaced "My Expenses" link row with "Recent expenses" + empty-state section |
| `src/components/mobile/__tests__/MobileShell.test.tsx` | 15 new tests for scroll architecture, role nav, dashboard labels |

---

## Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | 0 errors |
| `npm test -- --run` | 318/318 pass (15 new) |
| `npm run build` | Clean (pre-existing chunk size warnings only) |
| `git diff --check` | CRLF normalization warnings only |

---

## Items deferred to Phase 3

- Drafts tab on mobile Expenses
- Return Money dialog on mobile
- Per-route page-level mobile redesigns (New Expense form, batch form, Admin Panel mobile layout)
- Notification badge count on bell icon
- Swipe actions on expense cards

---

## NO COMMIT / NO PUSH / NO DEPLOY
