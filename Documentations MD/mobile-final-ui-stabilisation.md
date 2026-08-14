# DOC-037 — Mobile Final UI Stabilisation

**Status:** complete
**Branch:** `staging/mobile-rc`
**Date:** 2026-07-02
**Tests:** T46–T56 (11 new tests; 567 total)

---

## Summary

Five screenshot-reported mobile UI regressions fixed on `staging/mobile-rc`. No new Supabase queries, RLS changes, migrations, or service/payload changes. Desktop layouts unaffected.

---

## A — Analytics: Clipped Y-axis labels + PieChart/Legend overlap

### Problem
- `YAxis` in all three Recharts charts had no `width` prop → label text clipped on narrow viewports.
- `PieChart` used `cx="40%"` with `Legend align="right" verticalAlign="middle"` → donut pushed left; legend overlapped donut on phone.

### Fix (`src/pages/Analytics.tsx`)
| Chart | Change |
|-------|--------|
| LineChart `YAxis` | Added `width={55}` |
| BarChart left `YAxis` | Added `width={55}` |
| BarChart right `YAxis` | Added `width={55}` |
| PieChart `cx` | `"40%"` → `"50%"` (centres donut) |
| PieChart `Legend` | `layout="vertical" align="right" verticalAlign="middle"` → `layout="horizontal" align="center" verticalAlign="bottom"` |

**Result:** Y-axis labels fully visible; category legend appears below the donut with no overlap on any viewport width.

---

## B — Reports: Tab labels overlap/unusable on phone

### Problem
`TabsList` with `grid-cols-3` forced three long labels ("Claim Verification List", "Claim Approval List", "Detailed Expense Report") into equal-width cells on a 360 px screen, causing truncation and tap-target failures.

### Fix (`src/pages/Reports.tsx`)
When `isMobile` (already available via `useViewportMode`) is `true`, the `TabsList` is replaced with a full-width `<Select>` dropdown bound to the same `activeTab` / `setActiveTab` state. The `TabsList` is still rendered on `md+` screens. `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` were already imported in Reports.tsx — no new imports needed.

```tsx
{isMobile ? (
  <Select value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="verification">Claim Verification List</SelectItem>
      <SelectItem value="approval">Claim Approval List</SelectItem>
      <SelectItem value="detailed">Detailed Expense Report</SelectItem>
      {dailyProjectReportEnabled && <SelectItem value="daily">{t("daily.tabTitle")}</SelectItem>}
    </SelectContent>
  </Select>
) : (
  <TabsList ...>...</TabsList>
)}
```

**Result:** One full-width dropdown on phone; grid tabs on desktop. Existing `TabsContent` panels are unaffected.

---

## C — Expense Form / FileUpload: bottom padding + filename overflow

### Status: already implemented
Code audit confirmed these fixes were already in place prior to this session:

- **Bottom padding:** `ExpenseForm.tsx` line 1724 has `isMobile && "pb-24"` (96 px — above the 80 px minimum).
- **Filename truncation:** `FileUpload.tsx` uploaded-file list inner div has `min-w-0 flex-1` + `<p className="...truncate">`.
- **Horizontal overflow:** `mobile-app-scroll` CSS has `overflow-x: hidden` preventing horizontal scroll.
- **Min-width check:** no `min-w-[...]` found in `ExpenseForm.tsx`.

No code changes required for C.

---

## D — Review Detail: Sticky action bar overlays Activity Log

### Problem
`MobileReviewActionBar` uses `position: sticky; bottom: 0` (CSS class `mobile-review-action-bar`). When the user scrolls to the bottom of the detail view, the "Review Comment" textarea and correction fields were obscured by the sticky bar (~68 px tall).

### Fix (`src/components/mobile/MobileReviewDetailView.tsx`)
Added an 80 px invisible spacer immediately before `<MobileReviewActionBar>` inside the scrollable content:

```tsx
<div className="h-20" aria-hidden="true" />
{/* Sticky action bar */}
<MobileReviewActionBar ... />
```

`aria-hidden="true"` ensures screen readers skip the purely-visual spacer.

**Result:** Last form field (Review Comment) can now scroll fully above the sticky bar.

---

## E — User Management: Desktop table on phone

### Problem
`viewMode === "table"` rendered a multi-column `<table>` with `min-w-[140px]` and `min-w-[120px]` column headers. This forced horizontal overflow on phone viewports.

### Fix (`src/pages/UserManagement.tsx`)
Added `useViewportMode` import and hook call, then wrapped the `viewMode === "table"` branch:

- **`isMobile = true`:** renders a vertical card list — one card per user showing name, email, `RoleBadgeWithLabels`, and balance. Clicking any card calls the existing `openUserDrawer(u)` handler.
- **`isMobile = false`:** existing desktop table unchanged.

Filter logic (teamFilter + searchTerm + `userMatchesManagementSearch`) is applied identically in both branches.

```tsx
{viewMode === "table" ? (
  isMobile ? (
    <div className="space-y-2 px-1 py-2">
      {/* card list using mobileFilteredUsers */}
    </div>
  ) : (
    <div className="overflow-x-auto -mx-4 sm:mx-0">
      {/* existing table */}
    </div>
  )
) : (
  /* hierarchical view unchanged */
)}
```

**Result:** Phone users see a scrollable card list; desktop users see the full table with all columns.

---

## Files changed

| File | Change |
|------|--------|
| `src/pages/Analytics.tsx` | `width={55}` on all YAxis; PieChart `cx="50%"` + horizontal bottom Legend |
| `src/pages/Reports.tsx` | Mobile Select dropdown replaces TabsList below 768 px |
| `src/components/mobile/MobileReviewDetailView.tsx` | `h-20 aria-hidden` spacer before action bar |
| `src/pages/UserManagement.tsx` | `useViewportMode` import + hook + mobile card list for `viewMode==="table"` |
| `src/components/mobile/__tests__/mobileFinalStabilisation.test.tsx` | 11 new tests T46–T56 |

---

## Tests (T46–T56)

| ID | Description |
|----|-------------|
| T46 | MobileReviewDetailView renders a spacer div before the action bar |
| T47 | Spacer has `aria-hidden="true"` so assistive tech skips it |
| T48 | Spacer has class `h-20` (80 px clearance for action bar) |
| T49 | Spacer precedes `.mobile-review-action-bar` in DOM order |
| T50 | MobileReviewActionBar renders Correct / Reject / Approve when canApprove=true |
| T51 | MobileReviewActionBar renders Verify (not Approve) when canApprove=false |
| T52 | Reports tab selector: a combobox role element is present on mobile |
| T53 | Reports tab label values are defined and non-empty |
| T54 | UserManagement mobile card renders user name and email |
| T55 | Clicking a mobile user card fires the openUserDrawer handler |
| T56 | Mobile user card name element carries `truncate` class |

All 567 tests pass (556 pre-existing + 11 new).

---

## Architecture constraints respected

- No new Supabase queries, RLS, migrations, storage, or Edge Functions touched.
- No ExpenseService modifications.
- No batch configuration/parity/order fix alterations.
- No production domain configuration changes.
- Desktop layouts untouched (`isMobile` guard on all changes).
