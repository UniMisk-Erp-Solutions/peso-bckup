# DOC-024 — Mobile UI Phase 3A: Navigation + More Sheet Repair

**Status:** in progress  
**Last updated:** 2026-07-01  
**Affects:** `src/components/mobile/MobileBottomNav.tsx`, `src/components/mobile/MobileMoreSheet.tsx`, `src/locales/*/nav.json`

---

## Summary

Admin and reviewer roles now get a **5-item bottom nav** (Home | Expenses | FAB | Review | More) so that both Review and More are always visible. The More sheet gained role-aware sections, `aria-label`, and `data-testid` attributes for accessibility and testing.

---

## 1. Navigation configuration source reused

- `EXPENSE_REVIEW_ROLES` from `src/lib/routeAccess.ts` — determines who gets the Review tab
- `buildTabs()` logic follows the same role branching as `AppSidebar.tsx` adminItems / engineerItems / cashierItems without duplicating route-permission rules
- `buildSections()` in `MobileMoreSheet.tsx` mirrors `AppSidebar.tsx` admin nav items for its Administration section

---

## 2. Employee bottom-nav map

```
Home | Expenses | [FAB New] | More
```

4-item balanced layout. FAB is centred and raised. More is always present.

---

## 3. Reviewer bottom-nav map

Applies to: `engineer`, `team_leader`, `executive` (all roles in `EXPENSE_REVIEW_ROLES`)

```
Home | Expenses | [FAB New] | Review | More
```

5-item layout. Each slot is `flex-1 min-w-0` to prevent horizontal overflow at 360px. Labels are `text-[10px] truncate`.

---

## 4. Admin bottom-nav map

```
Home | Expenses | [FAB New] | Review | More
```

Same 5-item layout as reviewer. Admin explicitly included via `EXPENSE_REVIEW_ROLES.includes(role) || role === "admin"` (unchanged from Phase 2.5 fix).

---

## 5. Cashier bottom-nav map

**Cashier (can submit expenses):**
```
Home | Expenses | [FAB New] | More
```

**Cashier (no submission / blocked):**
```
Home | Balances | Transactions | More
```

**Cashier (accountant mode):**
```
Home | Approved | Notifications | More
```

More is always the rightmost item in every cashier variant.

---

## 6. Admin More-sheet routes

Grouped in three sections:

### WORKSPACE
- Notifications (`/notifications`)
- Reports (`/admin/reports`)
- Analytics (`/analytics`)
- My Teams (`/my-teams`, conditional on feature flag)
- Team Reports (`/team-reports`, conditional on feature flag)

### ADMINISTRATION
- All Expenses (`/admin/expenses`)
- Balances (`/balances`)
- Manage Users (`/admin/users`)
- Categories (`/admin/categories`)
- Settings (`/settings`)

### ACCOUNT
- Help (`/help`)
- Sign Out (button, below divider)

---

## 7. Employee More-sheet routes

Single unsectioned list:
- Analytics (`/analytics`)
- Notifications (`/notifications`)
- Settings (`/settings`)
- Help (`/help`)
- Sign Out (button, below divider)

---

## 8. More-active state

The More button lights up (`text-primary`) when the current pathname matches any "secondary" route from the More sheet:

```
/notifications, /settings, /analytics, /admin/expenses, /admin/users,
/admin/categories, /admin/reports, /balances, /cashier/transactions,
/transfer-offers, /cash-transfer-history, /my-teams, /team-reports,
/help, /accountant/*
```

Only one nav slot is active at a time: Home, Expenses, Review, and More are mutually exclusive by path.

---

## 9. Accessibility additions

| Addition | Where |
|----------|-------|
| `aria-label="More navigation"` | `<Drawer>` element in `MobileMoreSheet` |
| `data-testid="more-sheet"` | `<DrawerContent>` |
| `data-testid="more-sheet-item"` | Each `<NavLink>` in the sheet |
| Section headings (`<p>`) with uppercase label | Admin sectioned layout |

---

## 10. i18n keys added

Added to `en/nav.json`, `hi/nav.json`, `gu/nav.json`:

| Key | en | hi | gu |
|-----|----|----|-----|
| `sectionWorkspace` | Workspace | कार्यक्षेत्र | કાર્યક્ષેત્ર |
| `sectionAdministration` | Administration | प्रशासन | વ્યવસ્થાપન |
| `sectionAccount` | Account | खाता | ખાતું |

---

## 11. Files changed

| File | Change |
|------|--------|
| `src/components/mobile/MobileBottomNav.tsx` | 5-item layout for reviewer/admin; `isMoreActivePath` helper; `min-w-0` + `text-[10px] truncate` on all slots; More button shows active state |
| `src/components/mobile/MobileMoreSheet.tsx` | `SheetSection` type; `buildSections()` replaces flat `buildMoreItems()`; admin 3-section layout (WORKSPACE / ADMINISTRATION / ACCOUNT); `aria-label`, `data-testid` on Drawer/DrawerContent/NavLink |
| `src/locales/en/nav.json` | 3 section title keys |
| `src/locales/hi/nav.json` | 3 section title keys (Hindi) |
| `src/locales/gu/nav.json` | 3 section title keys (Gujarati) |
| `src/components/mobile/__tests__/MobileNav3A.test.tsx` | 30 new tests across 9 scenarios |

---

## 12. Test / build results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm test -- --run` | **348 / 348 pass** (30 new from `MobileNav3A.test.tsx`) |
| `npm run migrations:check` | No new migrations |
| `npm run build` | **Clean** (pre-existing chunk size warnings only) |
| `git diff --check` | CRLF normalization warnings only |

---

## 13. Mobile QA at 360 / 390 / 430 px

*Live browser QA via Chrome extension not possible for localhost. Verified via automated tests + code-path analysis.*

| Check | 360px | 390px | 430px |
|-------|-------|-------|-------|
| Reviewer/admin 5-item nav renders | ✓ test | ✓ test | ✓ test |
| Nav has no `position:fixed` | ✓ test | ✓ test | ✓ test |
| Each slot uses `flex-1 min-w-0` | ✓ class | ✓ class | ✓ class |
| Labels use `truncate` (no overflow) | ✓ class | ✓ class | ✓ class |
| Employee: More visible, no Review | ✓ test | ✓ test | ✓ test |
| Admin: Review AND More visible | ✓ test | ✓ test | ✓ test |

---

## 14. Desktop QA at 768 / 1024 px

`useViewportMode` returns `isMobile: false` at ≥ 768 px. `MobileAppShell` (and its children including `MobileBottomNav`) is not mounted. Desktop `AppSidebar` is unchanged. No CSS rules in the `@media (max-width: 767px)` block affect desktop layout.

---

## 15. NO COMMIT / NO PUSH / NO DEPLOY
