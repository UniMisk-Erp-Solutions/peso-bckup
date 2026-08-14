# DOC-027 — Mobile UI Phase 3 Combined: Admin Nav Balance + Mobile Expense Form + Receipt UX

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/components/mobile/MobileBottomNav.tsx`, `src/components/mobile/MobileMoreSheet.tsx`, `src/components/mobile/MobileExpenseFormLayout.tsx` *(new)*, `src/components/mobile/MobileStickyActionBar.tsx` *(new)*, `src/pages/ExpenseForm.tsx`, `src/components/FileUpload.tsx`, `src/index.css`, `src/components/mobile/__tests__/MobileNav3A.test.tsx`, `src/components/mobile/__tests__/MobileExpenseForm.test.tsx` *(new)*

---

## Summary

Three coordinated mobile improvements:

1. **Admin bottom nav — 5-item layout**: Admin now gets `Home | Expenses | [FAB] | All Expenses | More` in the bottom nav. All Expenses is removed from the admin More sheet to prevent duplication.
2. **Mobile expense form wrapper**: `MobileExpenseFormLayout` + `MobileStickyActionBar` provide a sticky action bar on mobile. ExpenseForm.tsx conditionally activates these when `isMobile=true`. Inline submit/cancel buttons are hidden on mobile and replaced by the sticky bar.
3. **FileUpload mobile variant**: `variant="mobile"` prop forces camera button and 44px touch targets regardless of `useIsMobile()` result.

All form state, validation, draft, upload logic, and submit remain in `ExpenseForm.tsx` — the new wrappers are purely presentational.

---

## 1. Admin bottom nav — 5-item layout

### Before (Phase 3B)

Admin fell through to the default 4-item layout: `[home, expenses, fab, more]`. All Expenses lived in the admin More sheet ADMINISTRATION section.

### After

`buildTabs` in `MobileBottomNav.tsx` now has an explicit admin case:

```tsx
if (role === "admin") {
  const allExpenses: Tab = {
    kind: "link",
    href: "/admin/expenses",
    Icon: Receipt,
    label: "All\nExpenses",
    ariaLabel: "All Expenses",
  };
  return [home, expenses, fab, allExpenses, more];
}
```

- `ariaLabel: "All Expenses"` → rendered as `aria-label="All Expenses"` on the NavLink
- Two-line label `"All\nExpenses"` → detected by `tab.label.includes("\n")`, rendered as two `<span className="block">` elements with `leading-tight`
- `LinkTab` type extended with optional `ariaLabel?: string`

**`MORE_ACTIVE_PREFIXES`**: `/admin/expenses` removed — All Expenses is now a primary nav tab, not a More route. The More button no longer activates when on `/admin/expenses`.

### MobileMoreSheet.tsx change

`ALL_EXPENSES` removed from admin `administrationItems`. Admin ADMINISTRATION section now: `[BALANCES, MANAGE_USERS, CATEGORIES, SETTINGS]`.

---

## 2. Mobile expense form

### MobileExpenseFormLayout.tsx (new)

Presentation wrapper. When `active=false` (desktop): renders `<>{children}</>` — fully transparent. When `active=true` (mobile): wraps in `<div className="mobile-expense-form-layout">`.

```tsx
export function MobileExpenseFormLayout({ active, children }: Props) {
  if (!active) return <>{children}</>;
  return <div className="mobile-expense-form-layout">{children}</div>;
}
```

### MobileStickyActionBar.tsx (new)

Sticky bottom bar with Submit and Cancel buttons. Props: `onSubmit`, `onCancel`, `submitLabel`, `disabled`, `loading`. Renders `<div className="mobile-sticky-action-bar">` — CSS handles `position: sticky; bottom: 0`.

Submit button: `disabled={disabled}` (blocks rapid double-tap; `isSavingRef.current` in ExpenseForm is the deeper guard). Cancel button: `disabled={loading}`.

### ExpenseForm.tsx changes

1. Imports `useViewportMode`, `MobileExpenseFormLayout`, `MobileStickyActionBar`.
2. Adds `const { isMobile } = useViewportMode();`.
3. Outer `return` wrapped in `<MobileExpenseFormLayout active={isMobile}>`.
4. Outer div gains `pb-24` on mobile to prevent last field being hidden behind sticky bar.
5. Inline submit/cancel buttons wrapped in `{!isMobile && (...)}` — hidden on mobile.
6. `MobileStickyActionBar` rendered as sibling to the content div when `isMobile`:

```tsx
{isMobile && (
  <MobileStickyActionBar
    onSubmit={saveExpense}
    onCancel={handleCancelForm}
    submitLabel={isEditing && expenseStatus === "rejected" ? t("form.resubmit") : t("form.submit")}
    disabled={loading || !formReady || !effectiveOrganizationId}
    loading={loading}
  />
)}
```

7. `FileUpload` receives `variant={isMobile ? "mobile" : undefined}`.

**Invariants preserved**: All form state/validation/draft/submit logic unchanged. `getBaseField("title").label` configurable labels flow through `MobileExpenseFormLayout` unchanged. Canonical `title` key unchanged. `useExpenseFormDraft` draft/edit modes unchanged.

---

## 3. FileUpload mobile variant

### Before

Camera button visibility: `showCameraCapture = isMobile || isStandaloneDisplayMode()`. No `variant` prop.

### After

```tsx
const showCameraCapture = variant === "mobile" || isMobile || isStandaloneDisplayMode();
const forceMobileLayout = variant === "mobile" || isMobile;
```

Button touch targets:
```tsx
className={cn("w-full sm:w-auto", forceMobileLayout && "min-h-[44px]")}
```

`variant="mobile"` allows callers (e.g. ExpenseForm on mobile) to force mobile UX explicitly. All upload logic, retry, failed state, progress bar, preview — unchanged.

---

## 4. CSS — index.css

Added to `@media (max-width: 767px)` section:

```css
.mobile-expense-form-layout { display: flex; flex-direction: column; }

.mobile-sticky-action-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  background: hsl(var(--background));
  border-top: 1px solid hsl(var(--border));
  z-index: 10;
  padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
}

/* iOS auto-zoom prevention (16px minimum) */
.mobile-expense-form-layout input,
.mobile-expense-form-layout textarea,
.mobile-expense-form-layout select { font-size: 16px; }

/* 44px tap target */
.mobile-expense-form-layout button,
.mobile-expense-form-layout [role="combobox"] { min-height: 44px; }
```

---

## 5. Tests

### MobileNav3A.test.tsx — updated

- Describe 3 title: "Admin bottom nav (4-item)" → "Admin bottom nav (5-item)"
- Test "admin nav has 4 slots" → "admin nav has 5 slots (home/expenses/fab/allExpenses/more)" — asserts All Expenses link present
- Test "admin nav has 2 links and 2 buttons" → "admin nav has 3 links and 2 buttons"
- Describe 4: "exposes All Expenses link" → "admin More sheet does NOT duplicate All Expenses (moved to nav)"

### MobileExpenseForm.test.tsx (new) — 16 tests

| # | Describes | Covers spec test |
|---|-----------|-----------------|
| 6/15 | MobileExpenseFormLayout passthrough + active mode | 6, 15 |
| 7/12 | MobileStickyActionBar callbacks | 7, 12 |
| 8/9 | Layout transparent for custom fields + validation | 8, 9 |
| 10/11 | Layout transparent for draft + edit mode | 10, 11 |
| 13 | FileUpload variant=mobile preserves failed/retry | 13 |
| 14 | Only one mobile scroll owner | 14 |

---

## 6. Files changed

| File | Change |
|------|--------|
| `src/components/mobile/MobileBottomNav.tsx` | Add admin 5-item case; add `ariaLabel` to `LinkTab`; two-line label rendering; remove `/admin/expenses` from `MORE_ACTIVE_PREFIXES` |
| `src/components/mobile/MobileMoreSheet.tsx` | Remove `ALL_EXPENSES` from admin `administrationItems` |
| `src/components/mobile/MobileExpenseFormLayout.tsx` | **New** — presentation wrapper |
| `src/components/mobile/MobileStickyActionBar.tsx` | **New** — sticky submit/cancel bar |
| `src/pages/ExpenseForm.tsx` | Import + use `useViewportMode`, wrap return in `MobileExpenseFormLayout`, add `MobileStickyActionBar` on mobile, hide inline buttons on mobile, pass `variant="mobile"` to `FileUpload` |
| `src/components/FileUpload.tsx` | Add `variant?: "mobile"` prop; `showCameraCapture` and `forceMobileLayout` account for variant |
| `src/index.css` | Add `.mobile-expense-form-layout` and `.mobile-sticky-action-bar` CSS under `@media (max-width: 767px)` |
| `src/components/mobile/__tests__/MobileNav3A.test.tsx` | Update describe 3 (5-item), describe 4 (dedup assertion) |
| `src/components/mobile/__tests__/MobileExpenseForm.test.tsx` | **New** — 16 tests covering spec tests 6-15 |

---

## 7. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **382 / 382 pass** |
| `npm run migrations:check` | No new migrations |
| `npm run build` | **clean** |

---

## 8. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries | ✓ |
| No new packages | ✓ |
| No DB migrations | ✓ |
| No commit / push / deploy | ✓ |
| ExpenseService unchanged | ✓ |
| Receipt finalization unchanged | ✓ |
| Approval/review logic unchanged | ✓ |
| Batch form unchanged | ✓ |
| Desktop layout unchanged at ≥768px | ✓ — `MobileExpenseFormLayout active={false}` is a passthrough |
| Admin review not accessible on mobile | ✓ — not in nav, not in More sheet |
| Reviewer bottom nav unchanged | ✓ |

---

## 9. NO COMMIT / NO PUSH / NO DEPLOY
