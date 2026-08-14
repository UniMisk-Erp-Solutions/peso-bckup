# DOC-033 — Mobile UI Phase 6C: Employee 5-Tab Navigation + Mobile Settings + Final More-Sheet Audit

**Last updated:** 2026-07-01  
**Status:** complete  
**Tests:** 495 total (21 new in Phase 6C)

---

## What changed

### 1. Employee 5-tab bottom navigation

Employee role bottom nav was extended from 4 items to 5:

```
Home | Expenses | [FAB: New Expense] | Settings | More
```

Previously the employee had `Home | Expenses | [FAB] | More`. Settings was only reachable via the More sheet. It is now a direct first-class tab.

**File:** `src/components/mobile/MobileBottomNav.tsx`

Changes:
- Added `Settings as SettingsTabIcon` import from `lucide-react`
- `buildTabs()` default case (employee) now returns `[home, expenses, fab, settingsTab, more]`
- `settingsTab` has `href: "/settings"`, `Icon: SettingsTabIcon`, `label: "Settings"`, `ariaLabel: "Settings"`

### 2. isMoreActivePath — tabs-aware (double-active prevention)

When employee navigates to `/settings`, both the new direct Settings tab AND the More button would previously show as active (because `/settings` is in `MORE_ACTIVE_PREFIXES`).

Fix: `isMoreActivePath(pathname, directHrefs)` now takes a second parameter — the hrefs of all direct link tabs. If the current pathname is already handled by a direct tab, `isMoreActivePath` returns `false`.

**Implementation:**
```ts
function isMoreActivePath(pathname: string, directHrefs: string[]): boolean {
  if (directHrefs.some((h) => pathname === h || pathname.startsWith(h + "/"))) {
    return false;
  }
  return MORE_ACTIVE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
```

`directHrefs` is computed in the component from the current tab list:
```ts
const directHrefs = tabs
  .filter((t): t is LinkTab => t.kind === "link")
  .map((t) => t.href);
```

Result:
- Employee on `/settings` → Settings tab active, More NOT active ✓
- Admin on `/settings` → No direct settings tab → More IS active (correct) ✓

### 3. Settings removed from employee More sheet

**File:** `src/components/mobile/MobileMoreSheet.tsx`

Employee (default) case in `buildSections()` previously returned:
```ts
items: [ANALYTICS, NOTIFICATIONS, SETTINGS, HELP]
```

Now returns:
```ts
items: [ANALYTICS, NOTIFICATIONS, HELP]
```

Settings is not duplicated in both a direct nav tab and the More sheet.

### 4. Mobile Settings experience

**File:** `src/pages/Settings.tsx`

Added `isMobile` branch using `useViewportMode()`. When `isMobile` is true, the page renders `<MobileSettingsView>` instead of the desktop layout. All state, handlers, and feature flags from the existing Settings controller are passed as props — no new queries, no new state.

The mobile early return also includes all 4 dialogs that must work on mobile (rendered via React portals):
1. **Field editor dialog** — admin-only, controlled by `editingFieldKey !== null`
2. **Restore backup confirmation** — controlled by `restoreConfirmOpen`
3. **Add/Edit Location dialog** — controlled by `locationDialogOpen`
4. **Delete Location confirmation** — controlled by `deleteLocationDialogOpen`

**New file:** `src/components/mobile/MobileSettingsView.tsx`

A phone-first settings layout component. Props interface mirrors the exact types from `Settings.tsx`. Sections rendered:

| Section | Visible to |
|---------|-----------|
| Dashboard Appearance (theme selector) | All roles |
| Language (`<LanguageSelector />`) | All roles |
| PWA Install (`<PwaInstallSettingsSection />`) | All roles |
| Notifications (popup, sound, desktop toggles) | All roles |
| Team Management (`<TeamManagementSection />`) | Admin + teamsEnabled |
| Daily Report (`<DailyExpenseReportMappingSection />`) | Admin + dailyProjectReportEnabled |
| Admin Settings (limits, toggles, batch mode, Save) | Admin/master_admin |
| Expense Form Builder (field list + Save) | Admin/master_admin |
| Expense Detail View Order (reorder + Save) | Admin/master_admin |
| Organisation Logo (upload + delete) | Admin/master_admin |
| Locations (list + Add/Edit/Delete) | Admin/master_admin |
| Data & Backup (download + restore) | Admin/master_admin |

Design:
- Cards with `CardHeader` + `CardContent` for each section
- 44px minimum touch targets on all interactive elements
- `data-testid` attributes: `mobile-settings-view`, `mobile-settings-appearance`, `mobile-settings-notifications`, `mobile-settings-admin`, `mobile-settings-form-builder`, `mobile-settings-detail-empty`, `mobile-settings-save`, `mobile-settings-save-form-builder`, `mobile-settings-save-detail-view`, `theme-option-{legacy,old-money}`

### 5. Final navigation maps (locked)

| Role | Nav tabs |
|------|----------|
| **employee** | Home \| Expenses \| [FAB] \| **Settings** \| More |
| **admin** | Home \| Expenses \| [FAB] \| All Expenses \| More |
| **engineer / team_leader / executive** | Home \| Expenses \| [FAB] \| Review \| More |
| **cashier** (with expense allowance) | Home \| Expenses \| [FAB] \| More |
| **cashier** (no expense allowance) | Home \| Balances \| Transactions \| More |
| **accountant/cashier** | Home \| Approved \| Notifications \| More |

### 6. More-sheet audit results

| Role | Settings in More? | Notes |
|------|------------------|-------|
| employee | ✗ removed | Direct tab instead |
| admin | ✓ still present | In Administration section |
| engineer / TL / exec | ✓ still present | In flat list |
| cashier | ✓ still present | In flat list |
| accountant/cashier | ✓ still present | In flat list |

Admin More: never had All Expenses or Review (confirmed — those would duplicate direct tabs).  
Reviewer More: no Review duplicate (confirmed).

### 7. Pre-existing test updated

`src/components/mobile/__tests__/MobileNav3A.test.tsx` — test "employee sheet does contain Notifications and Settings" was updated to "employee sheet contains Notifications but not Settings (Settings is a direct nav tab)". Now asserts `queryByText("Settings")` is absent from employee More sheet.

---

## Files changed

| File | Change type |
|------|------------|
| `src/components/mobile/MobileBottomNav.tsx` | Modified — 5-item employee nav, `isMoreActivePath` tabs-aware |
| `src/components/mobile/MobileMoreSheet.tsx` | Modified — Settings removed from employee section |
| `src/pages/Settings.tsx` | Modified — `useViewportMode` import, `isMobile` branch, mobile early return with all 4 dialogs |
| `src/components/mobile/MobileSettingsView.tsx` | **New** — phone-first settings layout component |
| `src/components/mobile/__tests__/MobileNavPhase6C.test.tsx` | **New** — 21 tests (T1–T21) |
| `src/components/mobile/__tests__/MobileNav3A.test.tsx` | Modified — updated stale employee More assertion |

---

## Test summary (Phase 6C — 21 new tests)

**T1–T12 Navigation:**
- T1: Employee nav has 5 tabs (Home, Expenses, FAB, Settings, More)
- T2: Employee Settings tab links to `/settings`
- T3: Employee on `/settings` — Settings active, More NOT active
- T4: Employee More sheet does NOT contain Settings
- T5: Employee More sheet contains Analytics, Notifications, Help
- T6: Admin nav has All Expenses direct tab, no Settings direct tab
- T7: Admin More sheet has neither All Expenses nor Review
- T8: Reviewer (engineer) nav has Review direct tab
- T9: Reviewer More sheet has no duplicate Review link
- T10: Cashier More sheet still contains Settings
- T11: Employee More sheet has Sign Out
- T12: More active on `/analytics` for employee (not a direct tab)

**T13–T21 MobileSettingsView:**
- T13: Employee role — appearance + notifications shown, admin card absent
- T14: Admin role — admin settings + form builder cards present
- T15: Theme selection fires `setDashboardTheme` with correct value
- T16: Active theme shows "Active" badge; inactive does not
- T17: Notification toggles call `updateNotificationSetting`
- T18: Admin Save Settings button present
- T19: Save Settings button fires `saveSettings` prop
- T20: Form builder Edit button fires `openFieldEditor`
- T21: Empty detail view state shown when `detailViewFields` is empty
