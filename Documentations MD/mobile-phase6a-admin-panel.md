# DOC-031 — Mobile UI Phase 6A: Admin Panel + All Expenses

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/pages/AdminPanel.tsx`, `src/App.tsx`, `src/components/mobile/MobileTopBar.tsx`, `src/components/mobile/MobileAdminExpenseCard.tsx` *(new)*, `src/components/mobile/MobileAdminExpensesView.tsx` *(new)*, `src/components/mobile/MobileAdminExpenseDetailView.tsx` *(new)*, `src/components/mobile/__tests__/MobileAdminPhase6A.test.tsx` *(new)*

---

## Summary

Two mobile experiences delivered for admin users:

**A. Mobile All Expenses (`/admin/expenses`)** — Card-based expense list replacing the desktop table on `≤767px`. Includes stats grid, quick links, search + status filter + custom field filter support, expense cards, and a full-screen detail view.

**B. `/admin` redirect** — A new `/admin` route (same role guard as `/admin/expenses`) redirects to `/admin/expenses`, matching the spec's intent without creating a separate controller.

**C. MobileTopBar `?from=admin` back nav** — Batch review opened from admin (`?from=admin`) now returns to `/admin/expenses` via the top bar back button.

No new Supabase queries. No new service methods. Desktop unchanged at ≥768px.

---

## 1. Architecture

### A. `AdminPanel.tsx` mobile branch

`useViewportMode()` is added after all other hooks. After the role-guard early return, a new `isMobile` branch returns mobile JSX before the desktop `return (...)`:

```
AdminPanel hooks (all run unconditionally)
  └─ if (userRole !== "admin") → access-denied return
  └─ if (isMobile) → MOBILE BRANCH (early return)
       ├─ selectedExpense is set → MobileAdminExpenseDetailView
       └─ selectedExpense is null → MobileAdminExpensesView
  └─ return (<div className="space-y-8"> ... </div>)   ← desktop (unchanged)
```

The correction dialog (for "Correct Expense") and `AttachmentPreviewDialog` are included in the mobile branch as overlays — they use the same AdminPanel state (`correctionDialogOpen`, `correctionLogs`, etc.).

### B. Data flow (mobile)

AdminPanel already has a `useEffect` that fires when `selectedExpense` changes:
```tsx
useEffect(() => {
  if (selectedExpense) {
    fetchAttachments(selectedExpense.id);
    fetchAuditLogs(selectedExpense.id);
    void fetchCorrectionLogs(selectedExpense.id);
  } else {
    setAttachments([]);
    setAuditLogs([]);
    setCorrectionLogs([]);
    setTimelineAssignees({});
  }
}, [selectedExpense]);
```

On mobile, `MobileAdminExpensesView.onSelectExpense` calls `setSelectedExpense(expense)` for non-batch expenses. This triggers the useEffect, which fetches attachments/audit logs/correction logs. The mobile detail view then renders them via props. **No new Supabase queries.**

For batch expenses, `onSelectExpense` navigates directly:
```tsx
navigate(`/expenses/batch/${expense.batch_id}/review?from=admin&expense=${expense.id}`)
```

### C. MobileTopBar back nav update

`getBackTarget` already had `from=review → /review` logic. Extended with `from=admin → /admin/expenses`:

```tsx
// Before:
return params.get("from") === "review" ? "/review" : "/expenses";

// After:
const from = params.get("from");
if (from === "review") return "/review";
if (from === "admin") return "/admin/expenses";
return "/expenses";
```

---

## 2. New components

### `MobileAdminExpenseCard.tsx`
- Exports `AdminExpenseRow` type (structural superset of the cards' needed fields; compatible with AdminPanel's local `Expense` type via structural subtyping)
- Renders: employee name, ID/email subline, title, destination, amount, expense date, status badge, batch/resubmitted badges, transaction #
- `data-testid="admin-expense-card"` for test queries
- CSS class `mobile-admin-expense-card` for T5 test

### `MobileAdminExpensesView.tsx`
- **Stats grid** (2×2): Total Users, Total Expenses, Pending, Total Amount
- **Quick links**: Users (`/admin/users`), Reports (`/admin/reports`)
- **Search** input + **Status** select + **ExpenseCustomFieldFilters** (existing component, shown when filterableCustomFields exist)
- **Load-all banner**: shows when `!allExpensesLoaded`
- **Expense card list** using `filteredExpenses` (pre-filtered + sorted by AdminPanel)
- **Empty state** with `data-testid="admin-expenses-empty"`
- Shows ALL filtered items (no mobile pagination — AdminPanel already fetches only 150 initial rows, filtered further by search)

### `MobileAdminExpenseDetailView.tsx`
- **In-component back button** (aria-label: "Back to expense list") — calls `onClose` which resets `selectedExpense` to null
- **Field grid** (rounded-xl border): Employee, Amount, Category, Purpose, Expense Date, Created, Txn #, Status (with Batch/Resubmitted badges)
- **Custom fields** via `ExpenseFormFieldsDisplay` (existing, makes its own query — acceptable as an existing component)
- **Admin comment textarea** (for actionable statuses) or **Update Status select** (for non-actionable)
- **Action buttons** (same logic as desktop dialog footer):
  - `submitted`/`edited`: Approve + Verify + Reject
  - `isAdminApprovableStatus` (hierarchy tiers): Approve + Reject
  - Otherwise: Update Status button
  - Optional: Correct Expense (when `canCorrect`)
- **Attachments** list with View button → `onImagePreviewOpen`
- **Correction audit log** (`ExpenseCorrectionAuditList`)
- **Review timeline** (`ExpenseReviewTimeline`)
- Imports `isAdminApprovableStatus` directly from `@/lib/approvalHierarchy` — no new logic

---

## 3. Route change

```tsx
// App.tsx — added before /admin/expenses:
<Route
  path="/admin"
  element={
    <ProtectedRoute allowedRoles={["admin", "cashier"]} blockAccountantCashier>
      <Navigate to="/admin/expenses" replace />
    </ProtectedRoute>
  }
/>
```

---

## 4. Navigation flow

```
MobileBottomNav "All Expenses" tab
  └─ navigates to /admin/expenses
       └─ AdminPanel (isMobile=true, selectedExpense=null)
            → MobileAdminExpensesView
                 ├─ tap non-batch card → setSelectedExpense(expense)
                 │    → MobileAdminExpenseDetailView
                 │         └─ back button → onClose() → null → MobileAdminExpensesView
                 └─ tap batch card
                      → navigate(/expenses/batch/:id/review?from=admin&expense=:id)
                           └─ MobileTopBar back → /admin/expenses   ← from=admin respected
```

---

## 5. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries in mobile components | ✓ — `ExpenseFormFieldsDisplay` is an existing component reused as-is |
| No new service methods | ✓ |
| Desktop admin panel unchanged at ≥768px | ✓ — `isMobile` branch is an early return; desktop JSX unreachable on mobile |
| Existing tests pass | ✓ — 441/441 prior tests pass |
| `MobileTopBar` prior back nav unchanged | ✓ — `from=review` still → `/review`; only `from=admin` added |
| Correction dialog accessible on mobile | ✓ — copied into mobile branch as an overlay Dialog using same AdminPanel state |

---

## 6. New test file

`src/components/mobile/__tests__/MobileAdminPhase6A.test.tsx` — 15 tests

| # | Group | Coverage |
|---|-------|----------|
| T1 | MobileAdminExpenseCard | renders employee name |
| T2 | MobileAdminExpenseCard | renders formatted amount |
| T3 | MobileAdminExpenseCard | renders Batch badge for batch expenses |
| T4 | MobileAdminExpenseCard | calls onSelect with the correct expense |
| T5 | MobileAdminExpenseCard | no table element; uses `.mobile-admin-expense-card` class |
| T6 | MobileAdminExpensesView | renders one card per expense |
| T7 | MobileAdminExpensesView | shows empty state when no expenses |
| T8 | MobileAdminExpensesView | renders totalUsers stat |
| T9 | MobileAdminExpensesView | no table element |
| T10 | MobileAdminExpenseDetailView | renders expense title |
| T11 | MobileAdminExpenseDetailView | renders back button with accessible label |
| T12 | MobileAdminExpenseDetailView | back button calls onClose |
| T13 | MobileAdminExpenseDetailView | shows Approve button for submitted expense |
| T14 | MobileTopBar | batch review + `?from=admin` → navigates to `/admin/expenses` |
| T15 | MobileAdminExpensesView | calls onSelectExpense with correct expense when tapped |

---

## 7. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **456 / 456 pass** (15 new + 441 prior) |
| `npm run migrations:check` | No new migrations |

---

## 8. NO COMMIT / NO PUSH / NO DEPLOY
