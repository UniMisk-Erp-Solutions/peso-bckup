# DOC-026 — Mobile UI Phase 3B.1: Desktop Dashboard Parity + Remove Admin Review

**Status:** complete  
**Last updated:** 2026-07-01  
**Affects:** `src/pages/Dashboard.tsx`, `src/components/dashboard/OldMoneyDashboard.tsx`, `src/components/mobile/MobileMoreSheet.tsx`, `src/components/mobile/__tests__/MobileNav3A.test.tsx`

---

## Summary

Phase 3B.1 makes the mobile dashboard look and behave like the desktop dashboard — same components, same information hierarchy, just scaled for phone screens. It also permanently removes the Review shortcut from admin's mobile More sheet.

Two changes:

1. **Desktop dashboard renders on mobile** — The `if (isMobile)` guard in `Dashboard.tsx` is removed. The full desktop dashboard (Legacy or Old Money theme) now renders inside `MobileAppShell`'s scroll container at all viewport widths. Tailwind responsive classes (`grid-cols-1 sm:...`) handle layout scaling on Legacy; new `@media(max-width:767px)` rules in `OM_CSS` handle phone scaling on Old Money.

2. **Review removed from admin More sheet** — The `REVIEW` item was added to the admin WORKSPACE section in Phase 3B. Per user direction ("i do not want that review thing as it is useless"), it is now removed. Admin has no Review link on mobile at all — not in the bottom nav (removed in Phase 3B), not in the More sheet (removed in Phase 3B.1).

---

## 1. Dashboard.tsx — remove mobile guard

### Before (Phase 3B)

```tsx
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileDashboardView } from "@/components/mobile/MobileDashboardView";

// inside component:
const { isMobile } = useViewportMode();

if (isMobile) {
  return <MobileDashboardView stats={stats} ... />;
}

if (dashboardTheme === "old-money" ...) {
  return <OldMoneyDashboard ... />;
}

// legacy dashboard JSX
```

### After (Phase 3B.1)

```tsx
// imports and const { isMobile } removed entirely

if (dashboardTheme === "old-money" ...) {
  return <OldMoneyDashboard ... />;
}

// legacy dashboard JSX — renders on both mobile and desktop
```

**Why this works:** `MobileAppShell` (mounted by `Layout.tsx` when `useViewportMode().isMobile`) provides `mobile-app-scroll` (overflow-y:auto) for scrolling and `MobileBottomNav` for nav — both active on mobile. The dashboard content just renders inside the scroll region. Legacy uses `grid-cols-1` at phone widths (single-column cards). Old Money uses inline CSS media queries.

`MobileDashboardView.tsx` and its tests remain in the repository but are no longer used by Dashboard.tsx.

---

## 2. OldMoneyDashboard.tsx — phone CSS

Added `@media(max-width:767px)` block to `OM_CSS`:

```css
@media(max-width:767px){
  .om-stats{grid-template-columns:repeat(2,1fr);gap:12px}
  .om-stat{padding:14px 16px}
  .om-stat-v{font-size:18px}
  .om-top h1{font-size:22px}
  .om-top p{font-size:13px;margin-top:8px}
  .om-big{font-size:28px;letter-spacing:-0.5px}
  .om-panel{padding:16px}
  .om-grid{gap:14px}
  .om-card{min-height:160px;padding:18px}
  .om-card-amt{font-size:24px}
  .om-donut-wrap{flex-direction:column}
  .om-donut{width:120px;height:120px}
  .om-bars{height:80px;gap:10px}
  .om-bc{gap:6px}
  .om-bar{width:6px}
  .om-ei{gap:16px;margin:16px 0;padding:14px 0}
  .om-v{font-size:16px}
}
```

The `@media(max-width:1100px)` rules already collapse the grid to single-column — these rules then fine-tune font sizes, padding, and component dimensions for 360–430px phones.

---

## 3. MobileMoreSheet.tsx — remove Review from admin WORKSPACE

### Before (Phase 3B)

```tsx
if (role === "admin") {
  const REVIEW: SheetItem = { href: "/review", Icon: ClipboardCheck, labelKey: "reviewExpenses" };
  const workspaceItems: SheetItem[] = [
    REVIEW,        // ← Phase 3B added this
    NOTIFICATIONS,
    REPORTS,
    ANALYTICS,
    ...(showMyTeams ? [MY_TEAMS, TEAM_REPORTS] : []),
  ];
```

### After (Phase 3B.1)

```tsx
if (role === "admin") {
  const workspaceItems: SheetItem[] = [
    NOTIFICATIONS,
    REPORTS,
    ANALYTICS,
    ...(showMyTeams ? [MY_TEAMS, TEAM_REPORTS] : []),
  ];
```

`ClipboardCheck` import is retained (still used by `APPROVED` for accountant-cashier sheet).

---

## 4. Test update — MobileNav3A.test.tsx

The test added in Phase 3B that asserted Review Expenses IS present in admin More sheet is flipped to a negative assertion:

```tsx
// Phase 3B test (removed):
it("exposes Review Expenses link in Workspace section", () => {
  renderSheet("admin");
  expect(screen.getByText("Review Expenses")).toBeInTheDocument();
});

// Phase 3B.1 replacement:
it("admin More sheet does NOT contain Review Expenses", () => {
  renderSheet("admin");
  expect(screen.queryByText("Review Expenses")).not.toBeInTheDocument();
});
```

---

## 5. Information hierarchy per theme on mobile

| Theme | Mobile rendering | Notes |
|-------|-----------------|-------|
| Legacy | Same desktop stat cards, notifications, action buttons — single-column at 360–430px via `grid-cols-1` | No separate mobile component |
| Old Money | Same `OldMoneyDashboard` — all 7 sections (Overview, 4-stat grid, Net Position, Monthly Spend, Where It Went, Wallet card, Recent Activity) | Phone CSS reduces font sizes and reflows donut to column-stack |

---

## 6. Admin Review presence on mobile — final state

| Location | Review present? |
|----------|----------------|
| Bottom nav | ✗ — removed in Phase 3B |
| More sheet | ✗ — removed in Phase 3B.1 |
| Reviewer roles (engineer / team_leader / executive) nav | ✓ — unchanged |

---

## 7. Files changed

| File | Change |
|------|--------|
| `src/pages/Dashboard.tsx` | Remove `useViewportMode` import, `MobileDashboardView` import, `isMobile` const, `if (isMobile)` block |
| `src/components/dashboard/OldMoneyDashboard.tsx` | Add `@media(max-width:767px)` rules to `OM_CSS` |
| `src/components/mobile/MobileMoreSheet.tsx` | Remove `REVIEW` const and from admin `workspaceItems` |
| `src/components/mobile/__tests__/MobileNav3A.test.tsx` | Flip Phase 3B "Review in More" test to negative assertion |

---

## 8. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **366 / 366 pass** |
| `npm run migrations:check` | No new migrations |

---

## 9. Invariants preserved

| Invariant | Status |
|-----------|--------|
| No new Supabase queries | ✓ — OldMoneyDashboard already fetched its own data; legacy reads existing `stats` prop |
| No new packages | ✓ |
| No DB migrations | ✓ |
| No commit / push / deploy | ✓ |
| Desktop layout unchanged at ≥768px | ✓ — `MobileAppShell` only mounts when `useViewportMode().isMobile === true` (≤767px in `Layout.tsx`) |
| Reviewer bottom nav unchanged | ✓ — engineer / team_leader / executive still get Review in nav |

---

## 10. NO COMMIT / NO PUSH / NO DEPLOY
