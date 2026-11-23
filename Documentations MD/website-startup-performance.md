# Website startup performance (load rarely-used pages on demand)

**Doc ID:** DOC-162  
**Status:** in progress  
**Last updated:** 2026-11-16  
**Owner / area:** Frontend performance (all pages)

---

## 1) Summary

The first download of the website was larger than it needed to be: one 1.8 MB (raw) startup file contained pages most
visitors never open right away, plus the chart library. Those pages now load on demand. **No feature, route, role check,
data call or screen was changed.** The only visible difference is a short page skeleton the first time one of the moved
pages is opened.

Measured with a production build (`vite build`), what `index.html` loads up front:

| | Before | After |
|---|---|---|
| Startup JS + CSS (raw) | 2,398 KB | 1,624 KB (-32%) |
| Startup JS + CSS (gzip, what users download) | 649 KB | 448 KB (-31%) |
| Main `index` file (raw) | 1,828 KB | 1,054 KB |

---

## 2) Problem / requirement

Owner request: "smoothness for the whole website including all pages", without changing functionality or features.
Analysis of the build (source-map breakdown of the startup file) found two avoidable causes:

1. `src/main.tsx` imported `MaintenanceAdminApplication` statically only to decide the `/admin/maintenance*` path.
   That pulled the maintenance admin screens and **recharts, lodash, d3** into every visitor's startup file.
2. `src/App.tsx` imported every page statically, including `ReviewExpenses` which contains `EngineerReview`
   (the largest page, ~5.5k lines, 244 KB of source), the marketing/legal pages and rarely used app pages.

---

## 3) Solution

- `src/maintenance/isMaintenanceAdminPath.ts` (new): the pathname check now lives in a tiny module. It is still
  re-exported from `MaintenanceAdminApplication.tsx`, so existing imports and tests are unchanged.
- `src/main.tsx`: `MaintenanceAdminApplication` is loaded with `lazyWithRetry` inside `<Suspense fallback={null}>`;
  the decision logic and the maintenance flow are untouched.
- `src/App.tsx`: these pages use `lazyWithRetry` (the same helper the admin pages already use, which keeps the
  stale-chunk recovery) wrapped in the existing `LazyPage` skeleton: Features, How it works, Security, Pricing,
  Contact, Privacy, Cookies, Terms, Disclaimer, the three legal notices, Expense batch form, Batch expense review,
  Review expenses (with EngineerReview), Transfer offers, Help, Notification settings.
- Deliberately kept loaded up front: Home (landing page), Auth, Dashboard, Expenses, Expense form, Expense detail,
  Notifications, Not found, because they are the first screens people use.

---

## 4) Key files

```
src/App.tsx
src/main.tsx
src/maintenance/isMaintenanceAdminPath.ts   (new)
src/maintenance/MaintenanceAdminApplication.tsx   (re-exports the path check)
```

---

## 5) Database / migrations

None. No SQL, no edge functions, no environment changes.

---

## 6) Test plan

- [x] `vite build` succeeds; startup size measured before/after (table above).
- [x] `tsc`: no new type errors in the changed files (existing errors in tests, `api/` and `connector/` are unrelated).
- [x] Related unit tests (maintenance, lazy loading, review pages): 600 passed; 1 file
      (`reviewReturnStateRoundTrip.test.tsx`) fails with a Node `AbortSignal` environment error inside react-router
      `navigate`; that test does not import any changed file.
- [ ] Manual smoke test on the deployed site: open `/`, `/features`, `/pricing`, `/privacy`, log in, open Dashboard,
      Expenses, a Review page (`/review`), Help, Notification settings, and `/admin/maintenance/login`.
- [ ] After deploy, confirm the first open of a moved page shows only a brief skeleton and no errors in the console.

---

## 7) Related docs

- [PITR archive copy (DOC-161)](./pitr-wal-archive-copy-hasto.md) (same session, unrelated change)
- `src/lib/lazyWithRetry.ts` and `src/lib/chunkRecovery.ts` (stale-chunk recovery used by the lazy pages)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-16 | 1.0 | Claude Code | Startup bundle -31% (gzip) by loading marketing/legal pages, rarely used app pages, Review (EngineerReview) and the maintenance admin screens on demand. No behaviour change. Not deployed. |
