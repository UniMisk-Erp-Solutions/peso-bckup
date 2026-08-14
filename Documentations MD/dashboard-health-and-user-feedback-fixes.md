# Dashboard Health & User Creation Feedback Fixes

**Doc ID:** DOC-070  
**Status:** complete  
**Last updated:** 2026-07-25  
**Owner / area:** Dashboard, Admin / UserManagement  

---

## 1) Summary

Three production defects fixed on `fix/dashboard-health-and-user-feedback`, merged to `main` on 2026-07-25.

**BUG-01 (High) — Aggressive `get_backend_health` polling ~every 2 seconds.**  
No canonical health module existed. The hook was polling far too frequently. Fixed by creating a canonical health module (`backendHealth.ts` + `useDashboardBackendHealth.ts`) with a 60-second interval, background-tab pause, and request deduplication via React Query.

**BUG-02 (Medium) — Dashboard health status always showed "unknown".**  
The Dashboard was reading `backend_health.status` from `/api/system-status`, which intentionally never probes Supabase and always returns `"unknown"`. Fixed by creating a separate, diagnostic-only Dashboard health flow that calls `get_backend_health` RPC directly and renders a health chip showing `Checking… / Healthy / Degraded / Unavailable`. "Unknown" never appears in normal Dashboard operation.

**BUG-03 (Low) — User creation did not consistently show the success toast.**  
Post-create optional operations (supervisor assignment, cashier/location linking, engineer location insert) used `throw` after the user record was already created. Those throws fell into the outer `catch` block which displayed "Error Creating User" and suppressed the success toast. Additionally, the success toast used hardcoded English strings instead of i18n keys. Fixed by wrapping each post-create step in its own try/catch, showing the success toast exactly once regardless of optional failures, and replacing hardcoded strings with i18n keys across EN/HI/GU.

---

## 2) Problem / requirement

### BUG-01 — Aggressive polling

The RPC `get_backend_health` was being called approximately every 2 seconds with no deduplication, no background-tab pause, and no canonical owner. Every component that needed health data independently scheduled its own interval. This generated unnecessary Supabase traffic and the DevTools showed overlapping in-flight requests.

### BUG-02 — Always "unknown"

`SystemAvailabilityContext` polls `/api/system-status` every 60 seconds. By architectural design, `publicSystemStatusHandler.ts` explicitly sets `backend_health = { status: "unknown", checked_at: ... }` and comments "Does NOT contact Supabase, does NOT probe any backend health." Dashboard components reading this context therefore always showed `"unknown"`. The production Supabase `get_backend_health` RPC was never called from the Dashboard at all — no health chip existed.

### BUG-03 — Success toast suppressed by optional setup failures

`handleCreateUser` in `UserManagement.tsx`:

1. Creates the user via `admin-create-user` edge function (line 601).
2. Confirms success at line 616: `if (!createResult?.success || !createResult?.user?.id)`.
3. Proceeds to optional post-create steps — each ending with `throw profileUpdateError` or `throw locationError`.
4. Any thrown error jumps to the outer `catch` (line 834) → "Error Creating User" destructive toast.
5. The success toast at line 797 is never reached for any role with optional profile fields.

Additionally the success toast used:
```ts
title: "User Created Successfully",
description: `${validated.name} has been created as ${validated.role}. Account is active and ready to use.`,
```
Hardcoded English — no i18n, no Hindi or Gujarati translation.

---

## 3) Solution

### BUG-01 & BUG-02 — Canonical health infrastructure

**`src/lib/backendHealth.ts`** (new)
- Exports `DashboardBackendHealthState = "checking" | "healthy" | "degraded" | "unavailable"` — "unknown" is not part of this type.
- Exports `DashboardBackendHealth` interface with `state`, `checkedAt`, `responseTimeMs`, `databaseReachable`, `authReachable`, `storageReachable`, `message`.
- Exports `INITIAL_HEALTH` — the `"checking"` sentinel returned while the first fetch is in flight.
- Exports `normalizeBackendHealthRpc(data, error, elapsedMs)` — pure, defensive normalizer:
  - RPC error → `unavailable`
  - `null`/`undefined` data → `unavailable`
  - `status: "unavailable" | "unreachable" | "error"` → `unavailable`
  - Any service flag `false` → `degraded`
  - `status: "degraded"` → `degraded`
  - Latency > 2 000 ms → `degraded`
  - Otherwise → `healthy`

**`src/hooks/useDashboardBackendHealth.ts`** (new)

React Query configuration:
```ts
staleTime: 45_000            // cache is fresh for 45s
refetchInterval: 60_000      // poll every 60s
refetchIntervalInBackground: false  // pause when tab is hidden
refetchOnWindowFocus: true   // refetch on tab return
retry: 1
retryDelay: 5_000
queryKey: ["dashboard-backend-health"]
placeholderData: INITIAL_HEALTH  // "checking" shown while first fetch is in flight
```

Single query key → React Query deduplicates multiple consumers into one in-flight request. Unmount cleanup is handled by React Query's `destroy()` lifecycle.

**`src/pages/Dashboard.tsx`** (modified)
- Imports `useDashboardBackendHealth`.
- Calls the hook inside the component: `const backendHealth = useDashboardBackendHealth()`.
- Adds `BackendHealthChip` component (defined in the same file):
  - Four states: `Checking…` (pulsing dot), `Healthy` (green), `Degraded` (yellow), `Unavailable` (red).
  - Shows "Last checked: HH:MM" alongside the status.
  - `title` tooltip: `"Diagnostic only. Does not activate maintenance."`
  - Rendered in the header, visible only when `userRole === "admin"`.
- Does NOT modify `SystemAvailabilityContext`, the maintenance system, or any route guard.

### BUG-03 — User creation toast

**`src/pages/UserManagement.tsx`** (modified)

`handleCreateUser` is restructured into clear phases:

- **Phase 1 (critical):** `admin-create-user` edge function. On failure → error toast + early return (same as before).
- **Phase 2 (optional, wrapped individually):** Team member insert, supervisor/cashier profile update, engineer cashier link, cashier location/engineer assignment + conflict check, engineer location insert. Each operation is wrapped in its own `try/catch`:
  - On error: `console.error(...)`, set `setupWarning = true`, continue.
  - On cashier conflict (location already has a cashier, engineer already has a cashier): log warning, `setupWarning = true`, skip assignment silently — do not abort user creation.
- **Phase 3 (non-throwing):** Email send (already wrapped), query invalidation, form reset.
- **Success toast (fires exactly once):**
  ```ts
  toast({
    title: t("admin:users.toast.userCreated"),
    description: setupWarning
      ? t("admin:users.toast.setupWarning")
      : t("admin:users.toast.userCreatedDescription", { name, role }),
  });
  ```

**`src/locales/en/admin.json`** — new keys added:
```json
"userCreated": "User Created Successfully",
"userCreatedDescription": "{{name}} has been added as {{role}}. The account is active and ready to use.",
"setupWarning": "User created, but some optional setup steps could not be completed."
```

Same keys added to `hi/admin.json` (Hindi) and `gu/admin.json` (Gujarati).

---

## 4) Architectural constraints preserved

- `SystemAvailabilityContext` is unchanged. It still polls `/api/system-status` which still returns `backend_health.status = "unknown"`.
- The maintenance system is manual-only. The new health chip does not activate maintenance, block routes, write Edge Config, sign users out, or alter any maintenance state.
- Dashboard health indicator is purely informational. The tooltip makes this explicit.
- No SQL, no migrations, no RLS changes.

---

## 5) Key files

```
src/lib/backendHealth.ts                                   (new — types + normalizer)
src/hooks/useDashboardBackendHealth.ts                     (new — React Query hook)
src/pages/Dashboard.tsx                                    (modified — imports hook, BackendHealthChip, renders chip)
src/pages/UserManagement.tsx                               (modified — post-create try/catch, i18n toast)
src/locales/en/admin.json                                  (modified — 3 new toast keys)
src/locales/hi/admin.json                                  (modified — 3 new toast keys)
src/locales/gu/admin.json                                  (modified — 3 new toast keys)
src/lib/__tests__/dashboardHealthAndUserFeedback.test.ts   (new — 66 tests)
```

---

## 6) Tests

**66 tests** — all passing (1 454 total, zero regressions):

| Group | Count | What they cover |
|---|---|---|
| BUG-02 — normalizer state machine | 15 | healthy / degraded / unavailable paths, latency threshold, unknown never emitted |
| BUG-02 — normalizer surface | 5 | checkedAt, message, field aliases (db_reachable) |
| BUG-01 — INITIAL_HEALTH | 7 | sentinel values, state = "checking" |
| BUG-01 — hook contract + enforcement | 11 | module shape, purity, message, flag semantics |
| BUG-03 — i18n keys (EN/HI/GU) | 15 | each locale has userCreated, userCreatedDescription, setupWarning with interpolation tokens |
| BUG-03 — regression (normalizer) | 5 | offline, malformed data, numeric flags |
| Regression — maintenance untouched | 4 | no maintenance/outage/activation exports |
| Regression — edge-cases | 5 | coerceBool, numeric flags, no-arg call |

---

## 7) Test plan

- [x] Admin logs in → Dashboard header shows `Checking…` chip briefly, then `Healthy` with last-check time
- [x] DevTools Network tab shows `get_backend_health` fired once on mount, then every 60 s (not every 2 s)
- [x] Switch to another browser tab → network requests pause; return → immediate refetch
- [x] Simulate Supabase outage (DevTools block) → chip shows `Unavailable`
- [x] Non-admin users → chip does not render
- [x] Create user (all feature flags OFF) → success toast fires in the user's current language
- [x] Create employee with invalid cashier assignment → "User created, but some optional setup steps…" toast; user record exists in DB
- [x] Create user (all feature flags ON, complete form) → full description toast: "{{name}} has been added as {{role}}. The account is active and ready to use."
- [x] 66 new tests pass; 1 454 total tests pass; zero regressions

---

## 8) Database / migrations

None. Pure frontend change — no SQL, no migrations, no RLS changes. The `get_backend_health` RPC is called via `supabase.rpc()` and must exist in the production database (it does; it was already present before this fix).

---

## 9) Related docs

- [DOC-064 — System Maintenance and Outage Control](./system-maintenance-and-outage-control.md)
- [DOC-068 — Reports Loading Fix + Auth Network Recovery](./reports-loading-and-auth-network-recovery.md)
- [DOC-069 — Admin Expense CSV Export Fix](./admin-expense-csv-fix.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-25 | 1.0 | Mithil Mistry | Initial — three bugs fixed, 66 tests, merged to main |
