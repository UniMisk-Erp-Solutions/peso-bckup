# System Status — Temporary Edge Config Disablement

**Doc ID:** DOC-072  
**Status:** active  
**Last updated:** 2026-07-28  
**Owner / area:** System maintenance, MasterAdminDashboard, SystemAvailabilityContext, public/master APIs

---

## 1) Summary

Temporary kill switch applied directly to `main` on 2026-07-28.

**Reason:** Vercel Edge Config read quota approaching exhaustion. The maintenance
system polls Edge Config on every `/api/system-status` request (every 60 s per
open browser tab). Until a replacement store (e.g., Supabase) is wired in, all
Edge Config reads and writes are suspended via a feature flag.

**Outcome:**
- Zero Edge Config reads.
- Zero Edge Config writes.
- Browser stops polling `/api/system-status`.
- Master Admin maintenance and broadcast cards perform no API requests.
- Maintenance never blocks ordinary users.
- No maintenance or broadcast banner appears.
- All implementation code is preserved for future reactivation.

---

## 2) Feature flags

### Client flag

**File:** `src/config/systemStatusFeature.ts`

```ts
export const SYSTEM_STATUS_CONTROL_ENABLED =
  import.meta.env.VITE_SYSTEM_STATUS_CONTROL_ENABLED === "true";
```

- Default: **disabled** — absent or non-`"true"` variable means false.
- Only the exact string `"true"` enables the feature.
- Do **not** fall back to `true`.
- Do **not** read any Edge Config value from the browser.

**Vercel env var to set when reactivating:**

```
VITE_SYSTEM_STATUS_CONTROL_ENABLED = true
```

### Server flag

**File:** `api/_lib/systemStatusFeature.ts`

```ts
export function isSystemStatusControlEnabled(): boolean {
  return process.env.SYSTEM_STATUS_CONTROL_ENABLED === "true";
}
```

- Default: **disabled** — absent or non-`"true"` variable means false.
- Do **not** use a `VITE_`-prefixed variable here.
- A missing `EDGE_CONFIG` must not generate errors while disabled.

**Vercel env var to set when reactivating:**

```
SYSTEM_STATUS_CONTROL_ENABLED = true
```

---

## 3) Disabled-mode behaviour per layer

### 3.1 Client polling (`SystemAvailabilityContext.tsx`)

When `SYSTEM_STATUS_CONTROL_ENABLED` is false:

- `SystemAvailabilityProvider` renders children under a stable `DISABLED_VALUE`:
  ```ts
  {
    state: "operational",
    blocking: false,
    status: null,
    initializing: false,
    lastCheckedAt: null,
    error: null,
    browserOnline: navigator.onLine,
    statusSource: "none",
    refreshStatus: () => {},
  }
  ```
- **Zero network requests** — no `fetch("/api/system-status")`, no polling timers,
  no `AbortController`, no visibility/focus/online listeners.
- All hooks live in `EnabledSystemAvailabilityProvider`, which is only rendered
  when the flag is true. This avoids conditional-hook violations.
- Stale cached/localStorage maintenance state is ignored.

### 3.2 Global banner (`App.tsx`, `Auth.tsx`)

```tsx
{SYSTEM_STATUS_CONTROL_ENABLED ? <SystemAlertBanner /> : null}
```

`SystemAlertBanner` is not mounted in either location when disabled.

### 3.3 Route guard (`ProtectedRoute.tsx`)

`ProtectedRoute` continues to call `useSystemAvailability()`. Because the
provider always exposes `blocking: false` and `initializing: false` when
disabled, `SystemUnavailableScreen` is never rendered and no user is blocked.

### 3.4 Public status endpoint (`api/_handlers/publicSystemStatusHandler.ts`)

When `isSystemStatusControlEnabled()` is false, the handler returns immediately
after method validation:

```json
{
  "schema_version": 1,
  "revision": "system_status_disabled",
  "server_now": "<ISO timestamp>",
  "state": "operational",
  "blocking": false,
  "source": "none",
  "title": null,
  "message": null,
  "starts_at": null,
  "ends_at": null,
  "estimated_end_at": null,
  "next_window": null,
  "backend_health": { "status": "unknown", "checked_at": "<ISO timestamp>" },
  "public_status_url": null,
  "feature_enabled": false,
  "request_id": "<id>"
}
```

- `buildSystemStatusStore()` is **never called**.
- `store.read()` is **never called**.
- No Edge Config client is created.
- No Supabase contact.
- `Cache-Control: no-store`.

### 3.5 Master maintenance API (`api/master/maintenance.ts`)

Returns HTTP 503 immediately after headers, before `verifyMasterAdmin`:

```json
{
  "ok": false,
  "code": "system_status_control_temporarily_disabled",
  "error": "Maintenance controls are temporarily unavailable.",
  "feature_enabled": false,
  "request_id": "<id>"
}
```

No auth, no store read, no store write, no Edge Config PATCH.

### 3.6 Master announcement API (`api/master/announcement.ts`)

Returns HTTP 503 immediately after headers, before `verifyMasterAdmin`:

```json
{
  "ok": false,
  "code": "system_status_control_temporarily_disabled",
  "error": "Broadcast announcements are temporarily unavailable.",
  "feature_enabled": false,
  "request_id": "<id>"
}
```

No auth, no store read, no store write.

### 3.7 Master Admin Dashboard (`src/pages/MasterAdminDashboard.tsx`)

```tsx
{SYSTEM_STATUS_CONTROL_ENABLED ? (
  <>
    <SystemMaintenanceCard />
    <SystemBroadcastCard />
  </>
) : (
  <SystemStatusDisabledCard />
)}
```

`SystemStatusDisabledCard` is a lightweight informational card — no buttons,
no requests. It explains that maintenance scheduling and broadcast announcements
are temporarily unavailable.

---

## 4) Files changed

| File | Change |
|---|---|
| `src/config/systemStatusFeature.ts` | **New** — client flag |
| `api/_lib/systemStatusFeature.ts` | **New** — server flag |
| `src/contexts/SystemAvailabilityContext.tsx` | Split into `EnabledSystemAvailabilityProvider` + disabled wrapper |
| `src/App.tsx` | `GlobalSystemStatusShell` guards `SystemAlertBanner` behind flag |
| `src/pages/Auth.tsx` | `SystemAlertBanner` guarded behind flag |
| `api/_handlers/publicSystemStatusHandler.ts` | Early return when disabled |
| `api/master/maintenance.ts` | Early 503 when disabled |
| `api/master/announcement.ts` | Early 503 when disabled |
| `src/pages/MasterAdminDashboard.tsx` | `SystemStatusDisabledCard` shown instead of maintenance/broadcast cards |
| `src/lib/__tests__/systemStatusDisablement.test.ts` | **New** — 56 tests |

## 5) Files NOT changed (preserved for reactivation)

```
api/_lib/edgeConfigSystemStatusStore.ts
api/_lib/edgeConfigWriteConfig.ts
api/_lib/systemStatusStore.ts
api/_lib/systemStatusTypes.ts
api/_lib/systemStatusEvaluator.ts
api/_lib/systemStatusEnvironment.ts
src/components/SystemAlertBanner.tsx
src/components/SystemUnavailableScreen.tsx
src/components/SystemMaintenanceCard.tsx
src/components/SystemBroadcastCard.tsx
src/components/maintenance/
src/lib/maintenanceDateTime.ts
@vercel/edge-config (in package.json)
```

---

## 6) Vercel Edge Config removal order

The code kill switch must be deployed first. Only after confirming:

1. Production `/api/system-status` returns `revision: "system_status_disabled"`.
2. Network tab shows zero recurring `/api/system-status` requests.
3. No maintenance overlay appears on any authenticated route.
4. Master Admin dashboard shows the disabled informational card.

…may you safely:

1. Disconnect the Edge Config from the Vercel project (Settings → Integrations).
2. Delete the Edge Config store (if no longer needed).
3. Remove env vars: `EDGE_CONFIG`, `EDGE_CONFIG_ID`, `EDGE_CONFIG_WRITE_TOKEN`, `VERCEL_API_TOKEN` (if only used for Edge Config).

---

## 7) Future replacement provider interface

When a new store (e.g. Supabase) is ready:

1. Create a new `api/_lib/supabaseSystemStatusStore.ts` that implements the
   `SystemStatusStore` interface (matching `read()` and `write()` signatures in
   `systemStatusStore.ts`).
2. Update `buildSystemStatusStore()` in `edgeConfigSystemStatusStore.ts` (or
   create a new factory) to return the Supabase store.
3. Set `SYSTEM_STATUS_CONTROL_ENABLED=true` and `VITE_SYSTEM_STATUS_CONTROL_ENABLED=true`.
4. Deploy Preview first and validate.
5. Deploy Production.

No changes needed to `SystemAvailabilityContext`, `ProtectedRoute`, `SystemAlertBanner`,
`SystemMaintenanceCard`, or `SystemBroadcastCard` — they all consume the store
through the flag-gated context.

---

## 8) Reactivation procedure

1. Implement replacement `SystemStatusStore`.
2. Wire it into `buildSystemStatusStore()`.
3. Set `SYSTEM_STATUS_CONTROL_ENABLED=true` in Vercel (server).
4. Set `VITE_SYSTEM_STATUS_CONTROL_ENABLED=true` in Vercel (client build).
5. Deploy Preview → validate all 56 disablement tests still pass + enabled-mode tests pass.
6. Deploy Production.
7. Confirm `/api/system-status` returns real Edge Config / Supabase data.
8. Confirm maintenance card appears in `/master`.

---

## 9) Rollback

To rollback to the previous state (before this kill switch):

```bash
git revert HEAD   # reverts the kill switch commit
git push origin main
```

This re-enables all Edge Config usage and polling immediately after deploy.

---

## 10) SQL / migrations

None. Pure frontend and API change — no SQL, no migrations, no RLS changes.

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-28 | 1.0 | Mithil Mistry | Initial — kill switch; 2 feature flags; 8 files modified; 56 tests; 1530 total; no SQL |
