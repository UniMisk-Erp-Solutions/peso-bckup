# DOC-039 — Emergency Mobile Responsive Layout Recovery

**Status:** complete
**Branch:** `staging/mobile-rc`
**Date:** 2026-07-02
**Tests:** T71–T83 (13 new tests; 595 total)

---

## Summary

Six screenshot-confirmed mobile UI regressions fixed. No Supabase queries, RLS, migrations, Edge Functions, or desktop layouts (≥768px) changed. All fixes are gated behind `isMobile` from `useViewportMode` or `variant="mobile"` prop.

---

## A — Analytics: Dedicated mobile chart presentation

### Problem

`Analytics.tsx` had no `useViewportMode` import or `isMobile` check. All three Recharts charts (LineChart, PieChart, BarChart) rendered identically on all screen sizes:
- Monthly Trend: full-size LineChart (height 300) with Legend overlapping on narrow screens
- Category Breakdown: PieChart with Recharts Legend rendered beside/below the donut; on 360 px the legend text clipped or wrapped onto the chart area
- Status Breakdown: dual-Y-axis BarChart with two overlapping Y-axis labels and cramped status labels across a 320 px width

### Fix

Added `useViewportMode` import and `const { isMobile } = useViewportMode();` to the Analytics component.

**Monthly Trend (≤767px):**
- Height reduced to 200 (from 300)
- `Legend` not rendered on mobile
- `XAxis` and `YAxis` tick `fontSize: 10`
- `YAxis.tickFormatter` uses compact notation: `₹Xk` / `₹XL` / `₹X`
- `Line.dot={false}` removes per-data-point dots to reduce clutter

**Category Breakdown (≤767px):**
- Recharts `<Legend>` not rendered (removed the legend overlap)
- Donut radii reduced to innerRadius=45, outerRadius=75
- Manual vertical category list rendered below the donut (`data-testid="mobile-category-list"`): color dot + category name (truncate) + amount (tabular-nums)

**Status Breakdown (≤767px):**
- Recharts `BarChart` not rendered (eliminated the dual-Y-axis cramp)
- Replaced with a vertical card list (`data-testid="mobile-status-list"`): coloured left-border (matching `STATUS_COLORS`), status name, count, amount in each row

Desktop (≥768px): all three charts unchanged.

---

## B — Reports: Tabs selector already correct

The `isMobile ? <Select> : <TabsList>` ternary added in DOC-037 is the only TabsList occurrence in `Reports.tsx`. The ternary is structurally correct — only one is rendered at a time. No further change needed.

---

## C — UserManagement: Hierarchy view mobile guard

### Problem

`viewMode === "hierarchical"` branch had no `isMobile` guard. The desktop hierarchy tree — a complex nested structure with location-based groupings, `UserHierarchySubordinates` components, statistics grids (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-6`) — was always rendered, even on 360 px phones.

Additionally, the Hierarchy toggle button was visible on mobile (it had `hidden sm:inline` on the label, meaning only the icon showed — but the button itself was still clickable and would trigger the unguarded hierarchy branch).

### Fix

**Toggle button:** Wrapped the Hierarchy `<Button>` in `{!isMobile && (...)}`. The button is not rendered on mobile at all. Table mode is always active on mobile regardless of `viewMode` state.

**Hierarchy branch:** Changed the outer ternary from:
```
viewMode === "table" ? (...) : (<desktop-hierarchy>)
```
To:
```
viewMode === "table" ? (...) : isMobile ? (<mobile-card-list>) : (<desktop-hierarchy>)
```

The mobile card list in the hierarchy branch reuses the same pattern as the table-mode mobile card list (filter by team/search, show name + email + role badge + balance). Attribute `data-testid="mobile-user-cards-hierarchy"` added for testability.

The `openUserDrawer(u)` handler is preserved on all mobile card taps.

---

## D — ExpenseForm: Form root width safety

### Problem

The form root div `<div className="... max-w-4xl mx-auto" ...>` did not have explicit `w-full min-w-0` on mobile. Inside `MobileExpenseFormLayout` (which uses a flex column container), a flex child without explicit width may not fill the available container width in all layout engines.

### Fix

Added `w-full min-w-0` to the `isMobile` conditional class in the form root div:
```tsx
isMobile && "pb-24 w-full min-w-0"
```

---

## E — FileUpload: `truncateFilenameForMobile` display helper

### Problem

Long filenames (e.g. `Screenshot_20260702_very_long_receipt_from_Chrome_browser.jpg`) could push the file-row card wider than the viewport even with `truncate` class, since CSS truncation only works when the element has a bounded width. The visual displayed text was the full filename — the truncation was handled by CSS overflow ellipsis, which doesn't tell the user how long the filename actually is.

### Fix — `src/lib/truncateFilename.ts` (new file)

Pure display helper:
```ts
export function truncateFilenameForMobile(filename: string, maxBaseChars: number): string {
  const lastDot = filename.lastIndexOf(".");
  const base = lastDot !== -1 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot !== -1 ? filename.slice(lastDot) : "";
  if (base.length <= maxBaseChars) return filename;
  return `${base.slice(0, maxBaseChars)}…${ext}`;
}
```

- Preserves the file extension for recognisability
- Uses the Unicode HORIZONTAL ELLIPSIS character `…` (U+2026)
- Does NOT modify the stored filename, temp path, or upload logic
- Pure function — no side effects, no imports

### Fix — `src/components/FileUpload.tsx`

- Imported `truncateFilenameForMobile` from `@/lib/truncateFilename`
- Filename display `<p>`: when `forceMobileLayout` is true, displays `truncateFilenameForMobile(attachment.filename, 20)` as the visible text; the full filename is always in `title` and accessible

---

## F — Public/Auth routes

No layout overflow was found in the auth/landing components (`Auth.tsx`, landing page components) at 360–430px. These components use Tailwind's responsive utility classes throughout and do not have fixed-width elements. No changes needed.

---

## Files changed

| File | Change |
|------|--------|
| `src/lib/truncateFilename.ts` | New — `truncateFilenameForMobile` pure helper |
| `src/pages/Analytics.tsx` | Added `useViewportMode` + `isMobile`; mobile branch for all three chart sections |
| `src/pages/UserManagement.tsx` | Hierarchy toggle hidden on mobile; hierarchy branch shows mobile card list when `isMobile` |
| `src/pages/ExpenseForm.tsx` | Form root div gets `w-full min-w-0` on mobile |
| `src/components/FileUpload.tsx` | Import + use `truncateFilenameForMobile` for filename display in mobile mode |
| `src/components/mobile/__tests__/mobileResponsiveRecovery.test.tsx` | 13 new tests T71–T83 |

---

## Tests (T71–T83)

| ID | Area | Description |
|----|------|-------------|
| T71 | D/truncate | Long base truncated with ellipsis + extension |
| T72 | D/truncate | Short filename returned unchanged |
| T73 | D/truncate | No extension — truncated without ext part |
| T74 | D/truncate | Exactly at maxBaseChars — not truncated |
| T75 | D/truncate | Multiple dots — only last extension preserved |
| T76 | D/upload | FileUpload mobile: long filename shown in truncated form |
| T77 | D/upload | FileUpload desktop: long filename shown in full |
| T78 | D/upload | FileUpload mobile: full filename in title attribute |
| T79 | D/upload | FileUpload mobile: filename `<p>` still has `truncate` CSS class |
| T80 | D/upload | FileUpload mobile file-row: min-w-0 + w-full + max-w-full present |
| T81 | D/truncate | Short filename with no extension unchanged |
| T82 | D/truncate | maxBaseChars=0 → `…` + ext |
| T83 | D/truncate | Result has exactly maxBaseChars base chars before ellipsis |

---

## Architecture constraints respected

- No Supabase queries, RLS, migrations, Storage, or Edge Functions touched
- No ExpenseService modifications
- No approval, batch, or permission logic changed
- Desktop layouts (≥768px) unchanged — all Analytics changes gated behind `!isMobile`; hierarchy changes gated behind `!isMobile`
- `truncateFilenameForMobile` is a display-only helper — stored filename, storage path, upload callbacks unaffected
- No `overflow-x: hidden` used as a width fix
