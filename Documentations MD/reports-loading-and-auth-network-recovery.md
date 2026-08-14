# Reports Loading Fix + Auth Network Recovery

**Doc ID:** DOC-068  
**Status:** complete  
**Last updated:** 2026-07-21  
**Owner / area:** Reports, Auth / AuthContext  

---

## 1) Summary

Two production defects fixed on `feature/user-activity-insights`, merged to `main` on 2026-07-21.

**A — ReferenceError: loading is not defined** — The Detailed tab in `/admin/reports` crashed at runtime with `ReferenceError: loading is not defined` whenever balance columns were shown. A bare `loading` identifier in the Closing Balance row guard had no declaration anywhere in the file; the fix replaces it with `detailedQuery.isLoading` (the TanStack Query flag already used throughout the component).

**B — TypeError: Failed to fetch (Supabase auth `_getUser`)** — A transient network failure during `supabase.auth.getUser()` could leave the app permanently stuck in a `loading=true` spinner (blank screen), and in some paths could incorrectly invoke `recoverFromInvalidAuthSession` on a network error instead of a genuine token failure. The fix adds an `isSupabaseNetworkError` helper, wraps `getValidatedAuthUser` defensively, patches the race guard in AuthContext to resolve loading, and adds a `window.online` listener for automatic recovery when connectivity returns.

---

## 2) Problem / requirement

### A — Reports crash (ReferenceError)

`src/pages/Reports.tsx` line 2534:
```tsx
{showDetailedBalanceColumns &&
  !loading &&           // ← free identifier — no useState, no const
  detailedListWithBalances.length > 0 && (
```

`loading` was never declared in the component. At runtime this threw `ReferenceError: loading is not defined`, crashing the entire Reports page for any user who had balance columns visible in the Detailed tab.

Line 2398 (correct pattern, already in the file):
```tsx
loading={detailedQuery.isLoading}
```

### B — Auth stuck-loading on network failure

Scenario: user has a valid local session in localStorage but no auth-context cache (e.g., first load after cache expiry). The normal auth path in `AuthContext.tsx`:

1. `onAuthStateChange` fires `INITIAL_SESSION` → guard matches userId → sets `session`/`user` state but skips `applySignedInSession`, so `loading` stays `true`.
2. IIFE calls `getValidatedAuthUser()` → `supabase.auth.getUser()` gets a network error → returns `{ user: null, error }`.
3. Race guard: `raceSession?.user` truthy → returns early → **`setLoading(false)` never called → app stuck on blank loading screen**.

Secondary issue: `getValidatedAuthUser` could throw (not return) on hard network failures, and callers had no try/catch. Also, `recoverFromInvalidAuthSession` was not guarded against network errors (though `isInvalidRefreshTokenError` happened to return false for "Failed to fetch", making it a no-op in practice — defensive fix applied regardless).

---

## 3) Solution

### A — Reports fix

Replace the free `loading` identifier at line 2534 with `detailedQuery.isLoading`:

```tsx
{showDetailedBalanceColumns &&
  !detailedQuery.isLoading &&
  detailedListWithBalances.length > 0 && (
```

### B — Auth network recovery

**`src/lib/authSession.ts`**

1. Added `isSupabaseNetworkError(error)` — checks for "failed to fetch", "fetch failed", "network request failed", "networkerror", "load failed", "connection refused", "etimedout", "econnrefused" (case-insensitive).

2. Wrapped `getValidatedAuthUser` in try/catch so hard-thrown network errors never propagate to callers. On a network error, skip `recoverFromInvalidAuthSession` (only genuine token failures should clear the session).

**`src/contexts/AuthContext.tsx`**

3. Import `isSupabaseNetworkError`.

4. Patched the normal-path race guard:
   - If `profileLoadedForUserIdRef.current` is set (INITIAL_SESSION listener already handled this user), call `setLoading(false)` explicitly before returning — resolves the stuck-loading bug.
   - If `raceSession?.user` exists (local session present but network failed), call `applySignedInSession(raceSession)` instead of returning silently — restores full auth state from the local session.

5. Added `window.addEventListener("online", handleOnline)` inside the auth `useEffect` — triggers a background `loadUserContext` call when connectivity recovers, refreshing stale data fetched while offline. Cleaned up in the effect's return.

---

## 4) Key files

```
src/pages/Reports.tsx                          (line 2534 — loading → detailedQuery.isLoading)
src/lib/authSession.ts                         (isSupabaseNetworkError, getValidatedAuthUser hardening)
src/contexts/AuthContext.tsx                   (race guard fix, online listener)
src/lib/__tests__/reportsLoadingFix.test.ts    (5 new tests)
src/lib/__tests__/authNetworkRecovery.test.ts  (15 new tests)
```

---

## 5) Database / migrations

None. Pure frontend fix — no SQL, no migrations, no RLS changes.

---

## 6) Test plan

- [x] Navigate to `/admin/reports` → Detailed tab → select a user with balance columns → Closing Balance row renders without crash
- [x] Simulate network failure during app load (DevTools → Offline) → app does not get stuck on blank loading screen; shows cached UI or login page
- [x] Restore network → `window.online` handler triggers background data refresh
- [x] Auth with bad refresh token still signs out (genuine token failure still calls `recoverFromInvalidAuthSession`)
- [x] All 1336 tests pass (zero regressions)
- [x] TypeScript: `tsc --noEmit` → 0 errors

---

## 7) Related docs

- [DOC-051 — User Activity Insights](./user-activity-insights.md) (feature branch these fixes were made on)
- [DOC-064 — System Maintenance and Outage Control](./system-maintenance-and-outage-control.md)
- [DOC-009 — Mobile upload & PWA stability fixes](./mobile-upload-and-pwa-stability-fixes.md) (earlier auth fast-path work)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-21 | 1.0 | Mithil Mistry | Initial doc — both defects fixed, 20 tests, merged to main |
