# DOC-021 — Mobile UI Phase 1: Phone Shell

**Status:** in progress  
**Last updated:** 2026-07-01  
**Affects:** `src/components/Layout.tsx`, `src/index.css`, 5 new files

---

## Summary

Adds a phone-first shell that gates at ≤767px viewport width. At that breakpoint the
entire app renders through `MobileAppShell` instead of the desktop `SidebarProvider`
tree — no component is ever double-mounted (no duplicate Supabase queries, no
duplicate Realtime channels).

Desktop behaviour at ≥768px is **completely unchanged**.

---

## Files created

| File | Purpose |
|------|---------|
| `src/lib/pageTitle.ts` | Extracted `PAGE_TITLES` map + `getPageTitle()` — shared by Layout.tsx and MobileTopBar |
| `src/hooks/useViewportMode.ts` | `useSyncExternalStore` hook at `(max-width: 767px)` — synchronous, no flash |
| `src/components/mobile/MobileAppShell.tsx` | Shell orchestrator — TopBar + scroll region + BottomNav + MoreSheet |
| `src/components/mobile/MobileTopBar.tsx` | 56px top bar — title, back button, bell, avatar |
| `src/components/mobile/MobileBottomNav.tsx` | Fixed 76px bottom nav — 4 slots + raised FAB |
| `src/components/mobile/MobileMoreSheet.tsx` | Vaul Drawer bottom sheet — role-aware secondary nav + sign out |

## Files modified

| File | Change |
|------|--------|
| `src/components/Layout.tsx` | Imports `useViewportMode` + `MobileAppShell`; early returns `<MobileAppShell>` when `isMobile`; notification popups repositioned to `bottom-24` on mobile path |
| `src/index.css` | Added `.mobile-fab-shadow` at `@media (max-width: 767px)` using `hsl(var(--primary) / 0.42)` — theme-adaptive |

---

## Key architectural decisions

### `useSyncExternalStore` — no flash

`useIsCompactLayout()` (existing, ≤1023px) uses `useEffect`, which starts `undefined`
and sets on mount — causes a desktop-first flash on phones. The new hook reads
`window.matchMedia().matches` synchronously on the first render via
`useSyncExternalStore`, so the correct branch is rendered on frame 0.

### Single-mount gating

```tsx
// Layout.tsx (simplified)
const { isMobile } = useViewportMode();
// ... all hooks ...
if (isMobile) return <><MobileAppShell />{notifPopups}</>;
return <SidebarProvider>...</SidebarProvider>;
```

Only one tree ever mounts. The existing `useIsCompactLayout` hook and sidebar remain
untouched.

### Hooks-before-branch rule

All `useState`, `useEffect`, and custom hooks in `Layout` are called **before** the
`isMobile` early return. The two `useEffect` calls (org-name sync + PWA standalone
class) both run on mobile — this is correct and intentional (`app-standalone-shell` is
needed for PWA lock on phone too).

---

## Bottom nav layout per role

| Role | Slot 1 | Slot 2 | Centre | Slot 4 |
|------|--------|--------|--------|--------|
| employee | Home | Expenses | FAB →/expenses/new | More |
| engineer / team_leader / executive | Home | Expenses | FAB →/expenses/new | Review |
| admin | Home | Expenses | FAB →/expenses/new | More |
| cashier (operational + can submit) | Home | Expenses | FAB →/expenses/new | More |
| cashier (operational, no submit) | Home | Balances | Transactions | More |
| cashier (accountant) | Home | Approved | Notifications | More |
| master_admin | Master | Settings | — | More |

FAB: 54×54px, `rounded-[18px]`, `bg-primary text-primary-foreground`, raised 20px
(`-mt-5`), `.mobile-fab-shadow`.

---

## Safe-area handling

- Top bar: `pt-safe` on `<header>` (adds `env(safe-area-inset-top)`)
- Bottom nav: explicit `<div style={{ height: 'env(safe-area-inset-bottom, 0px)' }}>`
  below the 76px content row
- Scroll container padding-bottom: `calc(96px + env(safe-area-inset-bottom, 0px))`
  clears the nav + FAB overhang

---

## More sheet items (role highlights)

- **admin**: All Expenses, Balances, Manage Users, Categories, Reports, Analytics,
  My Teams (if enabled), Notifications, Settings, Help, Sign Out
- **reviewer roles**: My Teams + Team Reports (if teams enabled + hierarchy enabled),
  Notifications, Settings, Help, Sign Out
- **cashier (accountant)**: Reports, Transfer History, Settings, Help, Sign Out
- **employee**: Analytics, Notifications, Settings, Help, Sign Out
- All roles: Sign Out always last, separated by divider

---

## Phase 1 constraints (not implemented)

- No mobile-specific page components — desktop pages render inside MobileAppShell
- No notification badge count on bell icon
- No balance widget in top bar
- Edit profile in top-bar avatar is deferred (opens More sheet only)

These are addressed in later phases (2–6 per the implementation plan).
