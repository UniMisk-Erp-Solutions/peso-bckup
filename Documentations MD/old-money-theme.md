# Old Money — optional dashboard/app theme

**Doc ID:** DOC-008
**Status:** in progress
**Last updated:** 2026-06-25
**Owner / area:** Dashboard, App shell, Settings, Theming

---

## 1) Summary

An optional, opt-in visual theme ("Old Money") that re-skins the whole app in a
private-banking aesthetic — warm ivory canvas, deep emerald, champagne-brass accents,
hairline rules, `Fraunces` serif for display/figures + `Inter` for UI. The original look is
preserved as the "Legacy" theme. Users switch in **Settings → Dashboard appearance**. The
choice is per-browser (localStorage) and applies app-wide; the Dashboard gets a bespoke
private-banking panel layout wired to real finance data.

---

## 2) Problem / requirement

The client wanted a premium, optional theme based on a supplied `design.html` / `design.md`
(private-banking visual system), without changing or breaking any existing feature, and with a
theme switcher to flip back to the current ("Legacy") UI.

---

## 3) Solution

- **Theme state** — `dashboardTheme.ts` (localStorage `pesowise-dashboard-theme`, values
  `legacy` | `old-money`, with a same-tab custom event + cross-tab storage event);
  `useDashboardTheme()` hook for reactive read/write.
- **Global re-skin** — `DashboardThemeApplier` sets `data-theme="old-money"` on `<html>` and
  loads the fonts. `index.css` overrides every shadcn design token under
  `html[data-theme="old-money"]` (ivory bg, emerald primary, brass ring, hairline borders,
  emerald sidebar tokens), remaps hard-coded Tailwind utility colors
  (blue/indigo/sky/violet/purple → emerald; amber/yellow → brass; light cool bg → ivory),
  premium rounding/shadows, themed thin scrollbars, and the typography
  (`Inter` base + `Fraunces` for headings and large figures).
- **Dashboard** — when the theme is active, `Dashboard` renders `OldMoneyDashboard` (panels:
  Net Position + month delta, KPI stat strip, Monthly Spend + approval split, category donut,
  engraved wallet card, Recent activity) using real data from `useOldMoneyDashboardData`
  (org-wide for admin/team-lead, personal otherwise). Card shows available balance, last-debit
  date, and the employee ID (where the org enables employee-id login) or a stable per-user
  number. Card is grid-area ordered first on mobile.
- **Sidebar** — `AppSidebar` adds (theme-only) a member-profile block + brass-accented active
  state via `index.css`; legacy is untouched.
- **Settings** — an "Dashboard appearance" card (Legacy / Old Money) for every user.

---

## 4) Key files

```
src/lib/dashboardTheme.ts
src/hooks/useDashboardTheme.ts
src/components/DashboardThemeApplier.tsx
src/components/dashboard/OldMoneyDashboard.tsx
src/hooks/useOldMoneyDashboardData.ts
src/pages/Dashboard.tsx           (renders OldMoneyDashboard when themed)
src/components/AppSidebar.tsx     (theme-only member profile block)
src/pages/Settings.tsx            (theme switcher card)
src/index.css                     (token overrides, utility remaps, fonts, sidebar, scrollbars)
src/App.tsx                       (mounts <DashboardThemeApplier/>)
```

---

## 5) Database / migrations

None. The theme is presentational and stored per-browser in localStorage. No schema, RLS, or
RPC changes.

---

## 6) Test plan

- [ ] Settings → Dashboard appearance → Old Money: whole app turns ivory/emerald, sidebar
      emerald with brass active accent + member profile, serif headings/figures.
- [ ] Switch back to Legacy: original look fully restored; no leftover theme styles.
- [ ] Dashboard (admin): Net Position, KPI strip, donut, bars, card, recent activity populate
      from real org data; (employee): personal data.
- [ ] Mobile width: wallet card appears first; layout single-column.
- [ ] No legacy feature/flow visibly changed when theme is off.

---

## 7) Related docs

- [Mobile upload & PWA stability fixes](./mobile-upload-and-pwa-stability-fixes.md) (DOC-009)
- [Mobile / PWA phone UI](./mobile-phone-ui.md) (DOC-007)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-25 | 1.0 | Agent | Initial: theme switch, global token re-skin, OldMoneyDashboard + data hook, sidebar restyle, Settings toggle, fonts, scrollbars, analytics strip, mobile card-first. |
