# DOC-025 — Mobile UI Phase 3B: Dashboard Content Parity + Admin Navigation Correction

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/components/mobile/MobileBottomNav.tsx`, `src/components/mobile/MobileMoreSheet.tsx`, `src/components/mobile/MobileDashboardView.tsx`, `src/pages/Dashboard.tsx`, `src/components/mobile/__tests__/MobileNav3A.test.tsx`, `src/components/mobile/__tests__/MobileDashboard3B.test.tsx`

---

## Summary

Phase 3B closes two gaps left after Phase 3A:

1. **Admin navigation correction** — Admin bottom nav reverts to 4-item `Home | Expenses | FAB | More`. Review moves inside the Admin More sheet (WORKSPACE section).
2. **Mobile dashboard content parity** — `MobileDashboardView` now renders real role-specific metrics (admin org balances, engineer review CTA, cashier return requests + transfer offers, employee/engineer Return Money action) instead of a generic stat pair and a static "No recent activity" placeholder.

---

## 1. Admin nav layout change

### Before (Phase 3A)
```
Home | Expenses | [FAB] | Review | More   ← 5-item
```

### After (Phase 3B)
```
Home | Expenses | [FAB] | More   ← 4-item
```

Review is now the first item in the Admin More sheet (WORKSPACE section).

### Motivation

Reviewer roles (engineer / team_leader / executive) need Review in the bottom nav because it is a high-frequency action for them. Admin uses Review occasionally — it belongs behind More alongside other admin tools.

### Code change

`MobileBottomNav.tsx` — removed `|| role === "admin"` from the `hasReviewNav` condition:

```tsx
// Before
const hasReviewNav = EXPENSE_REVIEW_ROLES.includes(role as AppOrgRole) || role === "admin";

// After
const hasReviewNav = EXPENSE_REVIEW_ROLES.includes(role as AppOrgRole);
```

---

## 2. Review added to Admin More sheet

`MobileMoreSheet.tsx` — a `REVIEW` item (`/review`, `ClipboardCheck`, `reviewExpenses`) is prepended to the `workspaceItems` array for admin:

```tsx
const REVIEW: SheetItem = { href: "/review", Icon: ClipboardCheck, labelKey: "reviewExpenses" };
const workspaceItems: SheetItem[] = [REVIEW, NOTIFICATIONS, REPORTS, ANALYTICS, ...];
```

---

## 3. MobileDashboardStats interface expanded

The local `MobileDashboardStats` interface now mirrors the full `DashboardStats` shape from Dashboard.tsx:

```typescript
interface MobileDashboardStats {
  totalExpenses: number;
  pendingAmount: number;
  approvedAmount: number;
  currentBalance: number;
  pendingReviews?: number;
  pendingReviewsAmount?: number;       // new
  pendingApprovals?: number;
  pendingApprovalsAmount?: number;     // new
  totalEmployeeBalance?: number;       // new
  totalEngineerBalance?: number;       // new (manager total)
  totalCashierBalance?: number;        // new
}
```

All values are already fetched by `Dashboard.tsx`'s `fetchStats()` — no new Supabase queries.

---

## 4. New props on MobileDashboardView

```typescript
interface Props {
  // ... existing props unchanged ...

  // Cashier return requests (fetched in Dashboard.tsx)
  returnRequests?: any[];
  loadingRequests?: boolean;
  onApproveRequest?: (id: string) => void;
  onRejectRequest?: (id: string, reason?: string) => void;

  // Employee / engineer return money action
  onReturnMoney?: (amount: string, note: string) => void;
  returningMoney?: boolean;
}
```

These are all optional — the component degrades gracefully if they are absent.

---

## 5. Role-specific dashboard layout

### Admin
1. Balance card (admin's own balance)
2. **Pending approvals CTA** — amber banner linking to `/admin/expenses` (hidden when 0, shows "No pending approvals" placeholder instead)
3. **Org-wide balances** — 3-column grid (Employee / Manager / Cashier), hidden when all zero
4. Stats grid (Total Expenses INR + Pending Amount)
5. New Expense button
6. Notifications (if any)
7. "All Expenses →" link

### Engineer / Reviewer
1. Balance card
2. **Pending reviews CTA** — blue banner linking to `/review` (only shown when `pendingReviews > 0`)
3. Stats grid (Pending amount + Approved amount)
4. New Expense button
5. **Return Money** button + Drawer (only shown when `onReturnMoney` prop is provided)
6. Notifications
7. "My Expenses →" link

### Employee
1. Balance card
2. Stats grid (Pending amount + Approved amount)
3. New Expense button
4. **Return Money** button + Drawer (only shown when `onReturnMoney` prop is provided)
5. Notifications
6. "My Expenses →" link

### Cashier (non-accountant)
1. Balance card
2. Stats grid
3. New Expense button (if `allowCashierExpenseSubmission`)
4. **`DashboardPendingTransferOffers`** component (existing, self-fetching)
5. **Return Requests list** — per-item Approve / Reject buttons (only when `returnRequests.length > 0`)
6. Notifications
7. "My Expenses →" link

---

## 6. "Recent Activity" placeholder removed

The static "No recent activity" / "Your latest expenses will appear here" empty state card has been replaced with a compact **"My Expenses →"** (or "All Expenses →" for admin) link row. This avoids false empty-state messaging on a page that never fetched expenses.

---

## 7. Loading skeleton fix (no ₹0 fallback)

The `if (loading) return <DashboardSkeleton />;` guard fires before any stat rendering. While `loading === true`, the screen shows only skeleton bones — no `₹0` values can appear.

---

## 8. Return Money on mobile

The Return Money action is rendered as:
- A **"Return Money"** secondary button visible to employee and engineer roles when `onReturnMoney` prop is provided
- Clicking opens a **Vaul `<Drawer>`** bottom sheet with:
  - Amount field (numeric, inputMode="decimal")
  - Note field (optional textarea)
  - "Submit Request" button (disabled while `returningMoney`)
  - "Cancel" button
- The drawer closes automatically when `returningMoney` flips `false → true → false` (detected via `useRef`)

In `Dashboard.tsx`, `handleReturnMoney` was adapted to accept optional `overrideAmount` / `overrideNote` params so mobile can call it with its own local dialog state without duplicating 150-line cashier-resolution logic.

---

## 9. Dashboard.tsx changes

| Change | Line area |
|--------|-----------|
| `handleReturnMoney(overrideAmount?, overrideNote?)` — accept optional params | ~575 |
| Use `overrideNote ?? returnNote` in `createReturnRequest` call | ~744 |
| Add 5 new props to `<MobileDashboardView>` render | ~914–926 |

---

## 10. Files changed

| File | Change |
|------|--------|
| `src/components/mobile/MobileBottomNav.tsx` | Remove admin from 5-item review nav |
| `src/components/mobile/MobileMoreSheet.tsx` | Add REVIEW to admin WORKSPACE |
| `src/components/mobile/MobileDashboardView.tsx` | Full rewrite — content parity |
| `src/pages/Dashboard.tsx` | handleReturnMoney params + new mobile props |
| `src/components/mobile/__tests__/MobileNav3A.test.tsx` | Update Test 3 (admin 4-item), add Review-in-More test, add `reviewExpenses` to t() mock |
| `src/components/mobile/__tests__/MobileDashboard3B.test.tsx` | New — 18 tests (Tests 5–7 from spec) |
| `src/components/mobile/__tests__/MobileShell.test.tsx` | Update 3 stale assertions to match new UI labels |

---

## 11. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **366 / 366 pass** (18 new from `MobileDashboard3B.test.tsx`, 1 updated in `MobileNav3A.test.tsx`) |
| `npm run migrations:check` | No new migrations |
| `npm run build` | (not yet run — build check is a separate gate) |

---

## 12. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries in mobile components | ✓ — `DashboardPendingTransferOffers` is an existing component with its own fetch; all `stats.*` fields already fetched in Dashboard.tsx |
| No new packages | ✓ |
| No DB migrations | ✓ |
| No commit / push / deploy | ✓ |
| Desktop layout unchanged | ✓ — `MobileBottomNav` / `MobileMoreSheet` / `MobileDashboardView` only mount when `isMobile: true` |
| Reviewer bottom nav unchanged | ✓ — engineer / team_leader / executive still get 5-item `[home, expenses, fab, review, more]` |

---

## 13. NO COMMIT / NO PUSH / NO DEPLOY
