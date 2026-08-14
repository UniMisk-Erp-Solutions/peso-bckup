# Mobile image upload, PWA tab-reload & navigation stability

**Doc ID:** DOC-009
**Status:** in progress
**Last updated:** 2026-06-25
**Owner / area:** Uploads/Compression, PWA/Service worker, Routing

---

## 1) Summary

Three connected reliability fixes: (a) image uploads failing on Android PWA and mobile
browsers while PDFs worked; (b) the whole app reloading (losing in-progress form data) when a
tab regained focus; (c) sidebar navigation that sometimes required a manual refresh to switch
pages. All fixes are frontend-only.

---

## 2) Problem / requirement

- **Images won't upload on mobile/PWA (PDFs do).** Root cause: the `compress-upload` edge
  function does **not** compress images (only PDFs), and client-side image compression timed
  out on mobile (main thread, no web worker, 12s). The uncompressed image then exceeded the
  2 MB cap → HTTP 400. PDFs succeeded because the server compresses them.
- **Tab-switch full reload / flash, losing progress.** Three causes:
  (a) service-worker `controllerchange` handler called `window.location.reload()` whenever a
  new SW activated mid-session (`src/lib/pwaInstallCapture.ts`);
  (b) Supabase emits `SIGNED_IN` on every tab focus, which in the old AuthContext called
  `setLoading(true)` + 6 DB queries → 700ms spinner that looks like a full reload;
  (c) Android PWA tab eviction reloads the page from scratch → same 700ms spinner on every
  cold start;
  (d) `INITIAL_SESSION` event fired by Supabase on every page load could override the
  localStorage fast-path and call `setLoading(true)` again if the event arrived after the
  fast-path already set `loading=false` — brief spinner on desktop/mobile reload.
- **Navigation needs a refresh.** Root cause: `lazyWithRetry` reloaded only once-ever (a
  persistent sessionStorage flag); after that a stale dynamic import just threw → Suspense
  never resolved → page wouldn't switch until manual refresh. Aggravated by the SW claiming
  clients mid-session and serving a different asset set.
- **Expense submission 20-30 seconds.** Root cause: 5-6 sequential `await` calls in the
  submit handler (`ExpenseForm.tsx`): `createExpense` → `moveTempFilesToExpense` →
  `enforceMaxAttachmentSize` → `expenseHasPersistedAttachments` → `saveFormFieldValues` →
  `submitExpense`. Plus a redundant `organization_settings` DB round-trip on every submit.
- **Dashboard loading slow.** Root cause: `fetchStats` in `Dashboard.tsx` awaited 4 DB
  calls sequentially (profile balance, expense summary, pending reviews, org role totals).
- **Expense list enrichment slow.** Root cause: `enrichExpenseList` in `Expenses.tsx`
  awaited 3 independent DB queries sequentially (resubmitted IDs, reviewer-corrected IDs,
  custom field map).
- **General app choppiness / 8-12 second query queue.** Root cause: `useOrganizationRoleLabels`
  was instantiated in 7 files simultaneously (including `Layout.tsx` on every page and
  `RoleBadgeWithLabels.tsx` rendered per user-list row), each firing an independent
  `organization_settings` DB query. `useAllowCashierExpenseSubmission` (5 instances) and
  `useRequireImmediateSupervisor` added more. Combined: 20+ concurrent queries to one table,
  saturating the self-hosted Supabase connection pool and queueing ALL other app queries
  (expense submit, dashboard, etc.) for 8-12 seconds.
- **Background auth refresh causing 3 re-renders per page load.** Root cause:
  `loadUserContext(isBackground=true)` ran 3 parallel DB queries (fetchUserRole,
  fetchUserProfile, fetchOrganization) completing at different times → 3 separate
  React re-renders of all `useAuth()` consumers, making every page feel choppy.
- **`fetchOrganization` blocking `loadUserContext` Promise.all.** Root cause:
  `supabase.auth.getUser()` (a network call for JWT validation) was `await`ed at the end of
  `fetchOrganization`, blocking the entire `Promise.all` until it resolved.
- **Custom field values wiped when user fills form, switches app to look something up, then returns.** Root cause (2026-06-26): `applyExpenseDraftFromStorage` (useCallback with `[activeUserId]` deps) closed over `fetchCategoryFormFields` directly. Because `activeUserId` (session cache, instant) becomes available before `organizationId` (DB round-trip), the captured `fetchCategoryFormFields` always had `organizationId = null`. On every draft restore (`visibilitychange visible` or page reload after OS kills tab), the null-org guard at the top of `fetchCategoryFormFields` fired and called `setFormFieldValues({})` — wiping all custom field values while leaving base fields (title, amount, date) intact.
- **App refreshes randomly on Android and desktop — users reporting it started today.** Three
  compounding causes (all discovered 2026-06-26):
  (a) `skipWaiting()` in `public/sw.js` install handler — every new deploy caused the new SW to
  take over immediately mid-session; 4 deploys today → 4 potential forced reloads per open tab.
  Old JS chunks served under the new SW name caused stale dynamic imports → `lazyWithRetry`
  called `window.location.reload()`;
  (b) `signOut` in `AuthContext.tsx` defined as a plain `async function` (not wrapped in
  `useCallback`) — new function reference on every render. Auth page's `useEffect` (lines
  101-124) lists `signOut` in its dep array → effect re-fired on every AuthContext re-render
  (each state change during login) → repeated concurrent `getValidatedAuthUser()` calls → some
  paths called `navigate("/dashboard")` redundantly, causing the loop;
  (c) `prepareForPasswordSignIn()` fires `SIGNED_OUT` before login, which resets
  `profileLoadedForUserIdRef.current = null`. If the IIFE's `getValidatedAuthUser()` resolved
  in this window, the existing ref guard didn't catch it → `clearAuthState()` wiped authenticated
  state just after login.

---

## 3) Solution

- **Uploads** — `uploadCompression.ts` `compressImage` now runs **progressive retry passes**
  (2400px/0.82 → 1800/0.62 → 1400/0.5 → 1100/0.42), keeps the smallest result, stops early once
  it fits the target, and uses a longer (25s) timeout. (Web worker stays off: the library loads
  its worker from a CDN blocked by the production CSP; the retries are what fix mobile.) The
  **per-file/total cap was raised 2 MB → 5 MB** consistently across `FileUpload.tsx`,
  `enforceMaxAttachmentSize` (`ExpenseForm.tsx`, `expenseBatchAttachments.ts`), the receipts
  backup cap (`expenseSubmittedBackupReceipts.ts`), and the size hints (en/hi/gu locales). The
  edge function honours the client-sent `absolute_cap_bytes`, so **no backend deploy is needed**.
- **PWA reload (cause a)** — removed the `controllerchange → window.location.reload()` in
  `pwaInstallCapture.ts`, and removed `clients.claim()` from `public/sw.js` so a new SW takes
  over on the next natural load instead of yanking control of open tabs.
- **Tab-switch SIGNED_IN flash (cause b)** — `AuthContext` now guards same-user `SIGNED_IN`
  events: if `profileLoadedForUserIdRef.current === session.user.id`, the event is treated as a
  silent session refresh (no `loading` toggle, no DB queries).
- **Auth cache for instant hydration (cause c)** — `AuthContext` writes `{ role, profile, org,
  orgId, orgFlags, membershipIsAccountantCashier, preferredLanguage }` to localStorage
  (`pesowise-auth-ctx-v1`) after every successful load. On the next page load the fast-path
  reads this cache, hydrates state, and sets `loading=false` immediately — no spinner. Token
  validation + DB refresh happen silently in the background. Cache is cleared on sign-out.
- **INITIAL_SESSION guard (cause d)** — `AuthContext` now applies the same same-user guard to
  `INITIAL_SESSION` events as it does to `SIGNED_IN`. If `profileLoadedForUserIdRef.current`
  already matches the session user (fast-path hydrated from cache), `applySignedInSession` is
  skipped — only the session/user state objects are refreshed, with no `loading` toggle.
- **Expense submit parallelization** — `ExpenseForm.tsx` submit handler restructured: removed
  redundant `organization_settings` DB fetch (uses `attachmentRequiredAboveAmount` state from
  init); `saveFormFieldValues` now runs concurrently with the `moveTempFilesToExpense →
  enforceMaxAttachmentSize` chain (both edit and create paths). Same error semantics preserved.
- **Dashboard stats parallelization** — `fetchStats` in `Dashboard.tsx` now launches all four
  independent fetches (`profile.balance`, `fetchDashboardExpenseSummary`,
  `fetchEngineerPendingReviewSummary`/`fetchMyTeamsPendingSummary`, `fetchOrgRoleBalanceTotals`)
  in a single `Promise.all` instead of sequential awaits.
- **Expense list enrichment parallelization** — `enrichExpenseList` in `Expenses.tsx` now
  launches all three independent enrichment queries (`fetchResubmittedExpenseIds`,
  `getExpenseIdsWithReviewerCorrections`, `fetchExpenseCustomFieldsMap`) in a single
  `Promise.all`.
- **Navigation** — `lazyWithRetry.ts` now retries the import once (400ms) before reloading, and
  the reload guard is **time-bounded** (30s cooldown) instead of once-ever, so a transient
  stale chunk self-heals rather than leaving navigation stuck.
- **`organization_settings` query storm eliminated** — new `src/lib/orgSettingsCache.ts`
  provides a module-level cache (5-min TTL, request coalescing). All three hooks
  (`useOrganizationRoleLabels`, `useAllowCashierExpenseSubmission`,
  `useRequireImmediateSupervisor`) and one-off page fetches (`ExpenseForm`,
  `EngineerReview`, `TeamManagementSection`) share a single in-flight Promise per org.
  20+ concurrent queries → 1. Cache is invalidated on writes in `Settings.tsx` and
  `TeamManagementSection.tsx`.
- **Auth background refresh throttled** — `AuthCtxCacheEntry` now stores `cachedAt`
  timestamp. Fast-path skips `loadUserContext(background=true)` if the cache is < 5 minutes
  old — eliminates 3 DB re-renders on every fresh page load.
- **`fetchOrganization` unblocked** — `supabase.auth.getUser()` at the end of
  `fetchOrganization` changed to fire-and-forget; no longer blocks the `loadUserContext`
  `Promise.all`.
- **Debug console.logs removed** — 5 `console.log`/`console.warn` calls in `ExpenseForm.tsx`
  attachment-limit init code removed.
- **Form data loss on app switch fixed — two-part fix:**
  (a) **Root cause removed:** `useExpenseFormDraft.ts` `onVisibility` handler no longer calls `restoreDraftIfAny` when the tab becomes visible. When the tab is alive, React state is still in memory — restoration is unnecessary and was invoking `applyDraft`'s closure (with a potentially stale `fetchCategoryFormFields`). Page-reload restores are fully covered by `pageshow` + `useLayoutEffect`, both of which wait for `organizationId` to be loaded before calling `restoreDraftIfAny`, so `fetchCategoryFormFields` always runs with a fresh closure. The `visibilitychange visible` handler now only calls `persistDraft` (updates the draft timestamp after the user returns).
  (b) **Defence-in-depth:** `fetchCategoryFormFieldsRef` added in `ExpenseForm.tsx` (updated every render). `applyExpenseDraftFromStorage` now calls `fetchCategoryFormFieldsRef.current(...)` instead of closing over `fetchCategoryFormFields` directly — same ref pattern as `persistRef`/`restoreRef` in the hook. Ensures the live `organizationId` is always used even if `applyExpenseDraftFromStorage` is ever called from a path where the closure could be stale.
- **App refresh bug (three-part fix):**
  (a) `skipWaiting()` removed from `public/sw.js` install handler; cache bumped `v11→v12`. New
  SW now waits for a natural full load before taking control of open tabs — no more mid-session
  asset-set switch → no more stale chunk imports → `lazyWithRetry` stops triggering reloads;
  (b) `signOut` in `AuthContext.tsx` wrapped in `useCallback([])` — stable reference across
  renders. Auth page useEffect no longer re-fires on every AuthContext state change;
  (c) IIFE's `clearAuthState()` guard strengthened: checks both `supabase.auth.getSession()`
  (in-memory, fast) AND `profileLoadedForUserIdRef.current`. Either being set means a session is
  active; neither can now be bypassed by the `prepareForPasswordSignIn()` SIGNED_OUT window.
- **Receipt move parallelization** — `moveTempFilesToExpense` (local function in `ExpenseForm.tsx`)
  changed from sequential `for...of` to `Promise.all`. With a self-hosted Supabase where each
  storage/DB round-trip takes 1-3s, the old sequential loop took 20-30s for 4 files (move →
  copy fallback → remove → DB insert × N files); parallel processing bounds it to the slowest
  single-file time (~5s).
- **Upload metadata removed** — `FileUpload.tsx` storage upload no longer sends a `metadata`
  field. Some self-hosted Supabase Storage versions return 400 on unrecognised metadata keys,
  causing ALL file uploads to fail with the error only visible in the network tab (not an
  obvious user-facing toast). Removed to fix compatibility. `upsert` changed to `true` so a
  retry of the same temp filename never hits a duplicate-conflict 400.
- **Duplicate upload success toast removed** — `FileUpload.tsx` already shows a success toast;
  the parent `onUploadComplete` callback in `ExpenseForm.tsx` was showing a second one. Removed
  the duplicate.

---

## 4) Key files

```
src/lib/uploadCompression.ts            (progressive image compression + timeout)
src/components/FileUpload.tsx            (5MB cap, 25s timeout, dynamic size message)
src/pages/ExpenseForm.tsx                (enforceMaxAttachmentSize 5MB; parallel submit; remove redundant org_settings fetch)
src/lib/expenseBatchAttachments.ts       (enforceMaxAttachmentSize 5MB)
src/lib/expenseSubmittedBackupReceipts.ts (backup cap 5MB)
src/locales/{en,hi,gu}/common.json       (size hint 5MB)
src/lib/pwaInstallCapture.ts             (remove controllerchange reload)
public/sw.js                             (remove clients.claim)
src/lib/lazyWithRetry.ts                 (retry + time-bounded reload guard)
src/contexts/AuthContext.tsx             (SIGNED_IN guard + localStorage auth cache + INITIAL_SESSION guard + cachedAt freshness check + fire-and-forget getUser)
src/pages/Dashboard.tsx                  (parallel fetchStats)
src/pages/Expenses.tsx                   (parallel enrichExpenseList)
src/lib/orgSettingsCache.ts              (NEW — shared org settings cache, 5-min TTL, request coalescing)
src/hooks/useOrganizationRoleLabels.ts   (use orgSettingsCache)
src/hooks/useAllowCashierExpenseSubmission.ts (use orgSettingsCache)
src/hooks/useRequireImmediateSupervisor.ts   (use orgSettingsCache)
src/components/TeamManagementSection.tsx (use orgSettingsCache in load + invalidate on save)
src/pages/Settings.tsx                   (invalidate orgSettingsCache on save)
```

---

## 5) Database / migrations

None. The `compress-upload` edge function is unchanged (it already reads `absolute_cap_bytes`
from the request), so no Coolify/edge deploy is required.

---

## 6) Test plan

- [ ] Mobile/phone view + Android PWA: add a 3–4 MB JPEG/PNG/HEIC photo → compresses and
      uploads without the "only PNG/JPG" or "exceeds limit" error; PDFs still work.
- [ ] Fill an expense form **with custom fields filled**, switch to another app (or tab), return → base fields AND custom fields are all still present. (Tests both the tab-alive visibilitychange path and, on mobile, the OS-kill + page-reload path.)
- [ ] Same scenario but switch apps within 1-2 seconds of filling a custom field → values still present on return.
- [ ] Fill an expense form, switch browser tabs, return → no full reload, form data intact.
      (Verify on a deployed/preview build — the SW only runs in production.)
- [ ] Reload the page (F5) while logged in → no spinner/flash; app shows immediately from cache.
- [ ] Submit a new expense with attachments → total time under 5 seconds (was 20-30s).
- [ ] Open Dashboard → stats populate without a visible sequential load delay.
- [ ] Open Expenses list → enrichment (resubmitted/corrected badges) appears without blocking.
- [ ] Click through sidebar items repeatedly → pages switch with no manual refresh; after a new
      deploy, a stale-chunk navigation recovers within one auto-reload (not stuck).
- [ ] Open UserManagement (many users with role badges) → network tab should show exactly 1
      `organization_settings` query, not 14+; all role badges appear at the same time.
- [ ] Submit an expense → total round-trip under 5 seconds (was 20s due to connection pool queue).
- [ ] Navigate between pages → no choppiness or re-renders of the sidebar/layout.

---

## 7) Related docs

- Legacy: [`docs/pwa-install-and-upload-fixes`](./pwa-install-and-upload-fixes.md) (DOC-006, MIME inference)
- Legacy: [`docs/mobile-expense-form-reset-on-photo-upload.md`](../docs/mobile-expense-form-reset-on-photo-upload.md) (DOC-L07)
- Legacy: [`docs/ISSUE_EXPENSE_SUBMIT_STORAGE_AND_ATTACHMENTS.md`](../docs/ISSUE_EXPENSE_SUBMIT_STORAGE_AND_ATTACHMENTS.md) (DOC-L06)
- Legacy: [`docs/service-worker-update-v5.md`](../docs/service-worker-update-v5.md) (DOC-L14)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-25 | 1.0 | Agent | Progressive mobile image compression + 5MB cap; removed SW controllerchange reload + clients.claim; lazyWithRetry retry + 30s reload cooldown. |
| 2026-06-25 | 1.1 | Agent | Added AuthContext SIGNED_IN same-user guard + localStorage auth-context cache for instant hydration — eliminates loading spinner on page reload / tab eviction / Android PWA cold start. |
| 2026-06-25 | 1.2 | Agent | Fixed INITIAL_SESSION race condition (cause d) — guards against fast-path cache being overridden by INITIAL_SESSION event. Parallelized expense submit chain (removed redundant org_settings fetch, saveFormFieldValues concurrent with attachment processing). Parallelized Dashboard fetchStats (4 concurrent DB calls). Parallelized Expenses enrichExpenseList (3 concurrent queries). |
| 2026-06-25 | 1.3 | Agent | Eliminated organization_settings query storm (20+ → 1): new orgSettingsCache.ts with 5-min TTL + request coalescing; all 3 hooks + ExpenseForm + EngineerReview + TeamManagementSection use shared cache; invalidation on write in Settings + TeamManagementSection. Auth background refresh throttled (cachedAt freshness check — skips 3 DB re-renders if cache < 5 min old). fetchOrganization getUser() made fire-and-forget. Debug console.logs removed from ExpenseForm. |
| 2026-06-25 | 1.4 | Agent | Parallelized moveTempFilesToExpense (sequential for-loop → Promise.all, main fix for 20-30s submission delay). Removed metadata from storage upload (self-hosted 400 compat fix). Changed upsert false→true. Removed duplicate upload success toast. SW bumped v9→v10. |
| 2026-06-26 | 1.5 | Agent | Fixed form-builder labels in single expense form: translateBaseFieldConfig now preserves custom DB labels (only applies i18n when label matches English default). Fixed daily report numeric cells showing ₹ symbol — replaced formatINR with toLocaleString("en-IN"). Fixed Edge reload loop: ErrorBoundary now uses same timestamp key format as lazyWithRetry (old '1' string caused reloadedRecently() to always return false → infinite reload on stale chunk). Added pageshow persisted check in useExpenseFormDraft to skip bfcache restores. SW bumped v10→v11. |
| 2026-06-26 | 1.6 | Agent | submitExpense sequential DB query storm fixed (10→3 effective stages): batch org_settings + isAdmin + isEngineer in parallel; eliminated canUserEditExpense (3 duplicate queries replaced with inline check); batch profile + submitterRole + loadHierarchyContext in parallel; loadHierarchyContext internals parallelised (4 sequential → 2 batches); entire post-UPDATE log+notify block made fire-and-forget (2–4 blocking awaits removed from user-visible path); duplicate expense.title and profile-name re-fetches eliminated. Expected: 20-30s → 5-7s. |
| 2026-06-26 | 1.7 | Agent | App refresh bug fixed (Android + desktop, reported as starting today): (1) removed skipWaiting() from sw.js install handler + bumped v11→v12 — new SW no longer yanks control of open tabs mid-session, eliminating stale-chunk reloads; (2) signOut wrapped in useCallback([]) in AuthContext — stable ref prevents Auth page useEffect from re-running on every render; (3) IIFE clearAuthState guard strengthened with getSession() check in addition to profileLoadedForUserIdRef — closes prepareForPasswordSignIn SIGNED_OUT timing gap. |
| 2026-06-26 | 1.8 | Agent | Fixed form data loss when user fills expense form, switches to another app, then returns (bug introduced today by the skipWaiting fix, which changed tab switches from full reloads to live-tab visibility events). Two-part fix: (1) removed restoreDraftIfAny from visibilitychange visible handler in useExpenseFormDraft — tab-alive path needs no restore; page-reload restore handled by pageshow + useLayoutEffect which wait for organizationId; (2) defence-in-depth: fetchCategoryFormFieldsRef ref pattern in ExpenseForm.tsx ensures applyExpenseDraftFromStorage always calls fetchCategoryFormFields with the current organizationId, never a stale null closure. |
