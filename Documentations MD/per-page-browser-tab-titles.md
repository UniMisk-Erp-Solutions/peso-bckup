# DOC-020 — Per-page browser tab titles

**Status:** deployed
**Last updated:** 2026-07-01
**Area:** UX — browser tab / window title

---

## Summary

All authenticated pages were showing "Sign in | PesoWise" in the browser tab regardless of
which route the user had navigated to. The Auth page set its title via `<Helmet>` and
`react-helmet-async` preserved it across SPA navigations because no authenticated page
component overwrote it.

Fix: `Layout.tsx` (the authenticated shell that wraps every protected route) now reads
`location.pathname` via `useLocation()` and sets a per-route `<title>` in its `<Helmet>`
block. Titles update on every client-side navigation without any server round-trip.

---

## Root cause

`src/pages/Auth.tsx` sets:
```tsx
<Helmet>
  <title>{t("auth:signInTitle")}</title>   // → "Sign in | PesoWise"
</Helmet>
```

`src/components/Layout.tsx` (the authenticated app shell) only set:
```tsx
<Helmet>
  <meta name="robots" content="noindex, nofollow" />
</Helmet>
```

No title tag → react-helmet-async left the previous title ("Sign in | PesoWise") intact for
every authenticated page because Helmet merges, not replaces, when no competing `<title>` is
provided. All other page components (Dashboard, AdminPanel, EngineerReview, etc.) had no
`<Helmet>` at all.

---

## Fix

**File:** `src/components/Layout.tsx`

### Changes

1. Added `useLocation` to the `react-router-dom` import.
2. Called `const location = useLocation()` inside the `Layout` component.
3. Added module-level `PAGE_TITLES` record and `getPageTitle(pathname)` helper above the component:

```ts
const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/expenses": "My Expenses",
  "/expenses/new": "New Expense",
  "/expenses/batch/new": "New Batch",
  "/admin/expenses": "All Expenses",
  "/admin/users": "User Management",
  "/admin/reports": "Reports",
  "/admin/categories": "Categories",
  "/accountant/expenses": "Approved Expenses",
  "/my-teams": "My Teams",
  "/team-reports": "Team Reports",
  "/settings": "Settings",
  "/review": "Review Expenses",
  "/analytics": "Analytics",
  "/cashier/transactions": "Transactions",
  "/cash-transfer-history": "Transfer History",
  "/transfer-offers": "Transfer Offers",
  "/notifications": "Notifications",
  "/balances": "Balances",
  "/master": "Master Admin",
  "/help": "Help & Tutorial",
  "/notification-settings": "Notification Settings",
};

function getPageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  if (/^\/expenses\/[^/]+\/edit$/.test(pathname)) return "Edit Expense";
  if (/^\/expenses\/batch\/[^/]+\/review$/.test(pathname)) return "Review Batch";
  if (/^\/expenses\/[^/]+$/.test(pathname)) return "Expense Details";
  return "PesoWise";
}
```

4. Updated the `<Helmet>` block in `Layout`'s JSX to include the dynamic title:

```tsx
<Helmet>
  <title>{getPageTitle(location.pathname)} | PesoWise</title>
  <meta name="robots" content="noindex, nofollow" />
</Helmet>
```

### Result

| Route | Tab title |
|-------|-----------|
| `/dashboard` | Dashboard \| PesoWise |
| `/expenses` | My Expenses \| PesoWise |
| `/expenses/new` | New Expense \| PesoWise |
| `/expenses/batch/new` | New Batch \| PesoWise |
| `/expenses/batch/:id/review` | Review Batch \| PesoWise |
| `/expenses/:id` | Expense Details \| PesoWise |
| `/expenses/:id/edit` | Edit Expense \| PesoWise |
| `/admin/expenses` | All Expenses \| PesoWise |
| `/admin/users` | User Management \| PesoWise |
| `/admin/reports` | Reports \| PesoWise |
| `/admin/categories` | Categories \| PesoWise |
| `/accountant/expenses` | Approved Expenses \| PesoWise |
| `/my-teams` | My Teams \| PesoWise |
| `/team-reports` | Team Reports \| PesoWise |
| `/settings` | Settings \| PesoWise |
| `/review` | Review Expenses \| PesoWise |
| `/analytics` | Analytics \| PesoWise |
| `/cashier/transactions` | Transactions \| PesoWise |
| `/cash-transfer-history` | Transfer History \| PesoWise |
| `/transfer-offers` | Transfer Offers \| PesoWise |
| `/notifications` | Notifications \| PesoWise |
| `/balances` | Balances \| PesoWise |
| `/master` | Master Admin \| PesoWise |
| `/help` | Help & Tutorial \| PesoWise |
| `/notification-settings` | Notification Settings \| PesoWise |
| `/auth` | Sign in \| PesoWise (unchanged — Auth.tsx still owns this) |

---

## Invariants preserved

- Auth page title unchanged — `Auth.tsx` keeps its own `<Helmet>` with `t("auth:signInTitle")`
- Marketing/public pages unchanged — they use `SEOHead.tsx` for their own titles
- `noindex, nofollow` meta tag still present on all authenticated pages
- No new dependencies — `useLocation` was already available from `react-router-dom` (already imported as `Link`)
- Zero type errors

---

## Revision log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-01 | Initial: per-route title map in Layout.tsx via useLocation; covers all 24 authenticated routes | Agent |
