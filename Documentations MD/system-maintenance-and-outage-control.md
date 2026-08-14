# DOC-064 — System Maintenance and Service Outage Control

**Status:** production-hardened (manual-only maintenance, scheduler UX redesign, live refresh hardening — 2026-07-19)
**Branch:** `main`
**Date:** 2026-07-16
**Last revised:** 2026-07-19 (custom time picker, background polling, reconcileAfterWrite, Edge Config write hardening)

---

## 1. Overview

A production-grade system maintenance and outage control plane for PesoWise with the following properties:

- **Independent control plane**: Vercel Edge Config (NOT Supabase-only). If Edge Config is absent, falls back to an in-memory store with a warning.
- **Two maintenance types**: manual/immediate (can be started right now) and scheduled windows (with an announcement period).
- **Manual-only blocking**: `blocking=true` is set ONLY by `manual_maintenance.enabled === true` or an active scheduled window. No Supabase health probe, no automatic outage detection.
- **Route blocking**: `ProtectedRoute` reads `SystemAvailabilityContext`; during `maintenance`, all non-Master-Admin users see `SystemUnavailableScreen`. Master Admin (`master_admin` role) is never blocked.
- **Auth outage hardening**: `bootstrapAuthSession` no longer calls `clearLocalAuthStorage()` on network errors — only on confirmed invalid/corrupt refresh tokens.
- **Global banner**: `SystemAlertBanner` is mounted once globally in `App.tsx` above all routes (including `/auth`). Shows for `upcoming` state only (dismissable per revision).
- **Auth-route gate**: `/auth` route is wrapped in `AuthMaintenanceGate` — shows `SystemUnavailableScreen` when blocking so login is blocked during maintenance.
- **No forced logout during maintenance**: users' sessions are preserved; they are blocked from navigation, not signed out.

---

## 2. Architecture

### 2.1 Server-side (Vercel Serverless Functions)

| File | Role |
|------|------|
| `api/_lib/systemStatusTypes.ts` | All canonical types: `SystemStatusDocument`, `PublicSystemStatus`, write payload union |
| `api/_lib/systemStatusEvaluator.ts` | Pure state evaluator + validation helpers (no I/O) |
| `api/_lib/systemStatusStore.ts` | `SystemStatusStore` interface + `InMemorySystemStatusStore` + pure `applyWrite` |
| `api/_lib/edgeConfigWriteConfig.ts` | Token resolution (VERCEL_API_TOKEN → EDGE_CONFIG_WRITE_TOKEN), team URL builder, safe error mapping |
| `api/_lib/edgeConfigSystemStatusStore.ts` | Edge Config-backed store + `buildSystemStatusStore()` factory |
| `api/_lib/systemStatusEnvironment.ts` | Server-only env readiness checks (read/write/auth); no secret values exposed |
| `api/_lib/verifyMasterAdmin.ts` | JWT validation + `profiles.is_master_admin` OR `master_admin_memberships.is_active` |
| `api/system-status.ts` | `GET /api/system-status` — public, no-cache, two-step health probe, always valid JSON |
| `api/master/maintenance.ts` | `GET + POST /api/master/maintenance` — Master Admin only, returns full document for immediate UI update |

### 2.2 State machine

Priority (highest → lowest):

1. **Manual maintenance** (`manual_maintenance.enabled = true`) → `state: "maintenance"`, `blocking: true`, `source: "manual"`
2. **Active scheduled window** (current time inside `starts_at..ends_at`) → `state: "maintenance"`, `blocking: true`, `source: "scheduled"`
3. **Upcoming announcement** (next window's `announce_from` ≤ now < `starts_at`) → `state: "upcoming"`, `blocking: false`, `source: "scheduled"`
4. **Operational** → `state: "operational"`, `blocking: false`, `source: "none"`

**`backend_health` is always returned as `{status: "unknown"}` in the public API response — informational only, never influences state, blocking, or source.**

### 2.3 Client-side

| File | Role |
|------|------|
| `src/lib/systemAvailability.ts` | Client types + pure helpers (`isBlockingState`, `formatCountdown`, etc.) |
| `src/contexts/SystemAvailabilityContext.tsx` | Polling provider (60 s normal, 15 s while blocking) |
| `src/components/SystemAlertBanner.tsx` | Global banner for `upcoming` state (mounted once in App.tsx, not Layout) |
| `src/components/SystemUnavailableScreen.tsx` | Full-page blocking screen (maintenance only — no outage copy) |
| `src/components/SystemMaintenanceCard.tsx` | Master Admin control card (start/end manual, schedule/cancel windows, grouped window list) |
| `src/components/maintenance/MaintenanceTimePicker.tsx` | Custom time picker: text input (not input[type="time"]) + SVG 12-hour clock popover, minute grid, AM/PM toggle |
| `src/components/maintenance/MaintenanceScheduleDialog.tsx` | Responsive schedule dialog — separate date+time fields, timezone display, inline validation, review panel |
| `src/lib/maintenanceDateTime.ts` | Pure timezone-safe date/time helpers: combineLocalDateAndTimeToUtcIso, parseManualTimeInput, formatCanonicalTimeForDisplay, normalizeClockTime, canonicalTimeToClockParts, etc. |

Provider order in `src/main.tsx`:
```
ErrorBoundary > HelmetProvider > SystemAvailabilityProvider > AuthProvider > I18nProvider > App
```

`SystemAvailabilityProvider` is mounted ABOVE `AuthProvider` so it works before auth resolves.

`SystemAlertBanner` is mounted inside `BrowserRouter` via `GlobalSystemStatusShell` — above all routes including `/auth`.

---

## 3. Optimistic Concurrency

All writes include a `revision` field (opaque string). The store enforces:

- Read current revision → apply write only if revision matches → write new document with new revision.
- Conflict (`409`) is returned to the client when revision is stale.
- `SystemMaintenanceCard` auto-refreshes on conflict and shows a toast.

---

## 4. Auth Outage Hardening

`src/lib/authSession.ts` — `bootstrapAuthSession()` changed from:

```typescript
// BEFORE (broken): clears tokens on ANY catch, including network errors
} catch {
  clearLocalAuthStorage();
}
```

to:

```typescript
// AFTER (correct): only clear on confirmed invalid/corrupt refresh token
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (isInvalidRefreshTokenError(msg)) {
    clearLocalAuthStorage();
  }
  // Network errors (503, abort, timeout) → leave storage intact
}
```

This prevents users from being signed out during a backend outage.

---

## 5. Service Worker Safety

`public/sw.js` already has `shouldBypassCache()` that skips all `/api/` paths — `/api/system-status` is auto-covered and never cached.

---

## 6. Required Environment Variables

### Server-side only (never exposed to client)

| Variable | Required | Purpose |
|----------|----------|---------|
| `EDGE_CONFIG` | Recommended | Vercel Edge Config connection string (auto-set by Vercel) |
| `EDGE_CONFIG_ID` | For writes | Edge Config store ID (for PATCH REST API) |
| `EDGE_CONFIG_WRITE_TOKEN` | For writes | Vercel API token with write permission on the Edge Config |
| `SUPABASE_SERVICE_ROLE_KEY` | Required | Used only in `verifyMasterAdmin.ts` for auth verification |
| `PUBLIC_STATUS_URL` | Optional | External status page URL forwarded to clients |

### Behavior when Edge Config is absent

The store falls back to `InMemorySystemStatusStore` (state resets on Vercel cold start). A console warning is emitted. This is acceptable for development; production should have Edge Config configured.

---

## 7. Master Admin UI

`SystemMaintenanceCard` (rendered on `MasterAdminDashboard`):
- Shows live current system state badge
- Start/end manual maintenance (with title, message, optional estimated-end time)
- **Grouped window list**: all windows shown by status (upcoming, in-progress, completed, cancelled) with formatted local times
- **Schedule dialog** (`MaintenanceScheduleDialog`): responsive `max-w-2xl` dialog with separate `date`+`time` inputs per stage, timezone header, UTC preview under each group, inline cross-field validation, review panel, and banner preview text
- Cancel any `scheduled` window inline from the grouped list
- Dialog closes **only after confirmed successful write** (not before)
- Optimistic concurrency: stale-revision conflict → auto-refresh + toast

### Emergency break-glass
If `POST /api/master/maintenance` is unavailable: Vercel Dashboard → Edge Config → manual JSON edit of `system_status` document.

---

## 8. Tests

New test files:

| File | Tests | Coverage |
|------|-------|---------|
| `src/lib/__tests__/systemStatusEvaluator.test.ts` | 26 | Pure evaluator, state transitions, pruneOldWindows, validation helpers |
| `src/lib/__tests__/systemStatusStore.test.ts` | 14 | applyWrite (all 4 actions, conflict detection), InMemorySystemStatusStore |

**Total: 40 new tests.** All pass alongside the 1121 pre-existing tests (75 test files / 1173 tests total).

---

## 9. No SQL Changes

This feature uses Vercel Edge Config for persistence, not Supabase. No migrations required.

---

## 10. Production-Hardening Repair (Phase K–Q, 2026-07-16)

### Root Causes Fixed

| # | Root Cause | Fix |
|---|-----------|-----|
| 1 | `fetchCurrentStatus()` returns `null` for any HTTP error; component has no UI for `null` → **blank card** | Replaced with `fetchAdminStatus()` returning typed `MaintenanceAdminLoadResult`; card never blank |
| 2 | `SystemMaintenanceCard` uses public `/api/system-status` — no auth, no diagnostics | Now uses `GET /api/master/maintenance` (authenticated, full document + store diagnostics) |
| 3 | `@vercel/edge-config` was not a direct dependency — silently missing in some environments | Added via `npm install @vercel/edge-config`; now at `^1.4.3` in `dependencies` |
| 4 | Production silently fell back to `InMemorySystemStatusStore` — state lost on cold start | `UnavailableSystemStatusStore` returns 503 with `code: maintenance_store_not_configured`; no silent memory fallback |
| 5 | `verifyMasterAdmin` checked `user_profiles.role === "super_admin"` — table/field doesn't exist | Now checks `profiles.is_master_admin = true` OR `master_admin_memberships.is_active = true` |
| 6 | Health probe used `/rest/v1/` which returns 401 → treated as server outage | Probe changed to `auth/v1/health`; 401/403/404 → `unknown` (non-blocking) |
| 7 | One failed health probe immediately triggered `blocking: true` | Two-step confirmation: second probe after 600 ms; only both unreachable → blocking outage |
| 8 | `ProtectedRoute` applied tenant verification before maintenance gate | Maintenance gate now evaluated first (after auth resolves); tenant work skipped while blocked |
| 9 | Master Admin could browse any page during maintenance | MA + blocking + not on `/master` → `<Navigate to="/master" replace />` |
| 10 | `SystemAlertBanner` was static text | CSS ticker with pause/hover/focus/reduced-motion/Pause button; `aria-live="polite"` |
| 11 | `SystemUnavailableScreen` called `window.location.reload()` | Uses `refreshStatus()` from `SystemAvailabilityContext`; distinct copy per scenario |
| 12 | Auth page had no maintenance awareness | `SystemAlertBanner` mounted above the sign-in card |
| 13 | `datetime-local` inputs labeled "UTC" but sent raw local string | Labels now show browser timezone; values converted via `new Date(...).toISOString()` before send |
| 14 | Write response discarded; required extra round-trip for UI update | `POST /api/master/maintenance` returns full saved document; card updates immediately |

### New / Changed Files

| File | Change |
|------|--------|
| `api/_lib/systemStatusEnvironment.ts` | **Created** — env diagnostics (read/write/auth readiness) |
| `api/_lib/edgeConfigSystemStatusStore.ts` | **Rewritten** — `UnavailableSystemStatusStore`; `getStoreDiagnostics()`; no silent memory fallback |
| `api/_lib/verifyMasterAdmin.ts` | **Rewritten** — correct tables, bounded timeouts, independent source fallback; anon key for identity request |
| `api/_handlers/publicSystemStatusHandler.ts` | **Created** — full implementation extracted from entry file |
| `api/_handlers/masterMaintenanceHandler.ts` | **Created** — full implementation extracted from entry file |
| `api/system-status.ts` | **Rewritten** — crash-safe wrapper; dynamic import of handler; module-init errors → valid JSON |
| `api/master/maintenance.ts` | **Rewritten** — crash-safe wrapper; dynamic import of handler; module-init errors → valid JSON |
| `src/contexts/SystemAvailabilityContext.tsx` | **Rewritten** — `refreshStatus()`, `browserOnline`, `error`, `statusSource`, transition timers |
| `src/components/ProtectedRoute.tsx` | **Rewritten** — maintenance gate before tenant check; MA restricted to `/master` |
| `src/components/SystemMaintenanceCard.tsx` | **Rewritten** — typed load result; 5 UI states; never blank; immediate write update |
| `src/components/SystemAlertBanner.tsx` | **Rewritten** — CSS ticker; pause/hover/focus/reduced-motion; `aria-live` |
| `src/components/SystemUnavailableScreen.tsx` | **Rewritten** — `refreshStatus()`; distinct copy per scenario |
| `src/pages/Auth.tsx` | **Updated** — `SystemAlertBanner` added |
| `src/locales/{en,hi,gu}/common.json` | **Updated** — `pauseTicker`/`resumeTicker` keys added |

---

## 12. Broadcast Announcement System (2026-07-16)

### Overview

Master Admin can publish a scrolling banner message that is visible to all users **even when the system state is operational** — independent of maintenance windows.

### Data Model Extension

`SystemStatusDocument` gains an optional `announcement` field:

```typescript
announcement: {
  id: string;           // same value as the revision that created it
  title: string;
  message: string;
  published_at: string; // ISO-8601 UTC
  updated_at: string;
} | null;
```

`PublicSystemStatus` gains `active_announcement` (always included, null when absent).

### New Write Actions

| Action | Effect |
|--------|--------|
| `publish_announcement` | Creates or replaces the active announcement; requires `title`, `message`, `revision` |
| `clear_announcement` | Sets `announcement: null`; requires `revision` |

### New Files

| File | Role |
|------|------|
| `api/master/announcement.ts` | Crash-safe wrapper (`GET + POST /api/master/announcement`) |
| `api/_handlers/announcementHandler.ts` | Full implementation |
| `src/components/SystemBroadcastCard.tsx` | Master Admin UI card |

### Banner Priority

`SystemAlertBanner` display priority (highest first):
1. `upcoming` (scheduled maintenance window in announcement period)
2. Broadcast `announcement` (independent, shown in any non-blocking state)
3. `degraded` (automatic health)

Announcements are dismissed per `id:published_at` stored in `sessionStorage`.

### Diagnostic Codes

| Code | Meaning |
|------|---------|
| `announcement_module_import_failed` | Handler file failed to load |
| `announcement_handler_execution_failed` | Handler threw at runtime |

---

## 13. Maintenance Endpoint Diagnostic Repair (2026-07-16)

The `api/master/maintenance.ts` wrapper previously placed both `await import(...)` and `await impl(req, res)` in a single try/catch, so a runtime error inside auth, Edge Config, or handler logic was mislabeled as `maintenance_function_initialization_failed`.

**Fix:** Two separate try/catch blocks:

```
Phase 1 (module import):  maintenance_module_import_failed
Phase 2 (handler exec):   maintenance_handler_execution_failed
```

This makes the diagnostic code unambiguous: `module_import_failed` means the bundle is broken; `handler_execution_failed` means the handler loaded but threw (auth, store, etc.).

---

## 11. Crash-Safe Serverless API Repair (Phase A, 2026-07-16)

### Root Cause

`package.json` has `"type": "module"` — the entire package is treated as ESM. When Vercel's Node.js serverless runtime loads `api/system-status.ts` or `api/master/maintenance.ts`, it resolves **all static top-level imports** before calling the handler. If any module in that import chain fails to initialize (e.g., `@vercel/edge-config` ESM/CJS interop, a missing transitive dependency), the function module itself fails to load. Vercel catches this and returns its own HTML 500 error page. The handler's `try/catch` block is **never reached**, so it cannot return JSON.

### Fix: Dynamic Import Wrapper Pattern

Entry files (`api/system-status.ts`, `api/master/maintenance.ts`) are now minimal wrappers with **zero static implementation imports**. The full logic lives in `api/_handlers/*.ts` and is loaded via `await import(...)` inside try/catch:

```typescript
// Entry file has no static implementation imports — only VercelReq/VercelRes types
export default async function handler(req: VercelReq, res: VercelRes) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const { default: impl } = await import("./_handlers/publicSystemStatusHandler");
    return await impl(req, res);
  } catch (err) {
    // Module failed to initialize — return safe JSON fallback
    return res.status(200).json({ state: "unknown", blocking: false, ... });
  }
}
```

If the dynamic import rejects (module-init failure), the catch block runs and returns valid JSON. The client always gets a parseable response.

### Additional: Separate anon key for user identity

`verifyMasterAdmin` now uses `SUPABASE_ANON_KEY` (or `VITE_SUPABASE_PUBLISHABLE_KEY` as fallback) for the `/auth/v1/user` identity request, and the service-role key only for privileged DB lookups (`profiles`, `master_admin_memberships`). This is correct minimal-privilege behavior.

| Variable | Purpose |
|----------|---------|
| `SUPABASE_ANON_KEY` or `VITE_SUPABASE_PUBLISHABLE_KEY` | Identity request (`/auth/v1/user`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged DB lookups only |

### Required Environment Variables

Configure in Vercel project settings. **Preview and Production are separate scopes** — set both.

| Variable | Required for | Notes |
|----------|-------------|-------|
| `EDGE_CONFIG` | Read maintenance state | Connection string from Vercel Edge Config |
| `EDGE_CONFIG_ID` | Write (management API) | From Vercel dashboard |
| `EDGE_CONFIG_WRITE_TOKEN` | Write (management API) | From Vercel → Edge Config → Tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | Master Admin verification | **Server-only. Never use `VITE_` prefix.** |
| `SUPABASE_URL` | Master Admin verification | Or falls back to `VITE_SUPABASE_URL` |
| `SUPABASE_HEALTH_URL` | Health probe (optional) | Defaults to `${SUPABASE_URL}/auth/v1/health` |
| `PUBLIC_STATUS_URL` | Status page link (optional) | Shown to users during outage |

Redeploy is required after adding/changing environment variables.

### Deployment Verification Checklist

- [ ] `GET /api/system-status` → valid JSON with `schema_version: 1`
- [ ] `GET /api/master/maintenance` with valid MA token → `ok: true`, `document`, `store`
- [ ] `GET /api/master/maintenance` without token → 401
- [ ] Master Admin card: never blank; shows controls when configured
- [ ] Start Maintenance → card updates immediately; refresh → persists
- [ ] Employee Dashboard → blocked; page component not mounted
- [ ] Master Admin → `/master` accessible; `/dashboard` redirects to `/master`
- [ ] End Maintenance → users recover without sign-in
- [ ] Simulate one health failure → no block
- [ ] Both probes fail → outage screen
- [ ] Browser offline → distinct offline screen (not maintenance)
- [ ] Cold start (new serverless instance) → reads same state from Edge Config

---

## 14. Environment Canonicalization Repair (Phase P2–P17, 2026-07-17)

### Root Causes Found and Fixed

| # | Root Cause | Fix |
|---|-----------|-----|
| 1 | `verifyMasterAdmin` accepted `VITE_SUPABASE_PUBLISHABLE_KEY` but NOT `VITE_SUPABASE_ANON_KEY` — the actual Preview environment variable | Added `VITE_SUPABASE_ANON_KEY` as the canonical VITE fallback for the anon key |
| 2 | `systemStatusEnvironment` reported `SUPABASE_SERVICE_ROLE_KEY` missing for auth, but `verifyMasterAdmin` does NOT use it | Aligned to the canonical resolver: auth needs URL + anon key only |
| 3 | `strict: false` without `strictNullChecks: true` meant `true`/`false` literals became `boolean` — discriminated unions couldn't narrow | Added `strictNullChecks: true` to `api/tsconfig.json` |
| 4 | Dynamic import in `api/system-status.ts` — module-init errors would show at runtime only | Replaced with static import + try/catch; errors caught at `npx vercel build` time |
| 5 | `api/_handlers/masterMaintenanceHandler.ts` and `api/_handlers/announcementHandler.ts` still existed but were unused (inlined at commit `ecbbfed`) | Deleted both files |
| 6 | Scheduler controls hidden behind `{!loading && readyData && status && ...}` | Restructured: always-visible sections A and B, disabled during load/error |
| 7 | `SystemBroadcastCard` replaced entire card with error box, clearing inputs | Preserved inputs on write failure; show detailed error with codes and missing vars |

### New Canonical Env Resolution Order

```
URL:      SUPABASE_URL → VITE_SUPABASE_URL
ANON KEY: SUPABASE_ANON_KEY → VITE_SUPABASE_ANON_KEY → VITE_SUPABASE_PUBLISHABLE_KEY
SERVICE:  SUPABASE_SERVICE_ROLE_KEY  (no VITE fallback — required for future privileged operations)
```

### Required Vercel Preview Environment Variables

For `VITE_*` Preview environments (current state):

| Variable | Value source |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase project settings → API → anon/public key |
| `EDGE_CONFIG` | Vercel Dashboard → Edge Config → linked automatically |
| `EDGE_CONFIG_ID` | Vercel Dashboard → Edge Config → your store ID |
| `EDGE_CONFIG_WRITE_TOKEN` | Vercel Dashboard → Edge Config → Tokens → create |

For Production (recommended dedicated server-side vars):

| Variable | Notes |
|----------|-------|
| `SUPABASE_URL` | Preferred over `VITE_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | Preferred over all VITE fallbacks |
| `SUPABASE_SERVICE_ROLE_KEY` | No VITE fallback — server-only |
| All Edge Config vars | Same as Preview |

### New / Changed Files (2026-07-17)

| File | Change |
|------|--------|
| `api/_lib/supabaseServerConfig.ts` | **Created** — canonical Supabase server env resolver (single source of truth) |
| `api/_lib/verifyMasterAdmin.ts` | **Updated** — uses supabaseServerConfig; added `VITE_SUPABASE_ANON_KEY`; 503 for missing config; `code` field on all failures; AbortController replacing Promise.race |
| `api/_lib/systemStatusEnvironment.ts` | **Updated** — uses supabaseServerConfig; auth diagnostics now accurate for Preview env |
| `api/tsconfig.json` | **Updated** — `moduleResolution: NodeNext`, `strictNullChecks: true`, `lib: ES2022`, `types: node` |
| `api/system-status.ts` | **Updated** — static import replaces dynamic import; `diagnostic_code: system_status_handler_execution_failed` |
| `api/master/maintenance.ts` | **Updated** — explicit `.ok === false` narrowing; structured error codes; 503 for config errors |
| `api/master/announcement.ts` | **Updated** — explicit `.ok === false` narrowing; structured error codes; 503 for config errors |
| `api/_handlers/masterMaintenanceHandler.ts` | **Deleted** — was unused after inlining at commit ecbbfed |
| `api/_handlers/announcementHandler.ts` | **Deleted** — was unused after inlining at commit ecbbfed |
| `api/contact.ts` | **Updated** — cast `.json()` result to `{ id?: string }` (revealed by strictNullChecks) |
| `src/components/SystemMaintenanceCard.tsx` | **Updated** — controls always visible; disabled during load/error/config-missing; new 503 code handling |
| `src/components/SystemBroadcastCard.tsx` | **Updated** — inputs preserved on failure; detailed error with codes/missing vars; config error is non-fatal |
| `package.json` | **Updated** — added `typecheck:api` script |
| `src/lib/__tests__/supabaseServerConfig.test.ts` | **Created** — T1–T7: server config resolution |
| `src/lib/__tests__/verifyMasterAdmin.test.ts` | **Created** — T8–T16: auth behavior, 503, timeout, no token leakage |

### TypeScript Changes

- `api/tsconfig.json` before: `module: NodeNext, moduleResolution: node16, strict: false`
- `api/tsconfig.json` after: `module: NodeNext, moduleResolution: NodeNext, strict: false, strictNullChecks: true, lib: ES2022, types: node`
- All 23 TS2339 errors on `authResult.status`, `writeResult.conflict`, `readResult.error` — resolved by `strictNullChecks: true` enabling literal `true`/`false` discrimination
- `npm run typecheck:api` now exits 0

### Test Results (2026-07-17)

- 79 test files, **1240 tests**, all passing
- +16 tests from new supabaseServerConfig and verifyMasterAdmin suites

---

## 15. Time Picker and Live Refresh Hardening (2026-07-19)

### Overview

Five workstreams committed as `fix: improve maintenance time picker and live refresh` (commit `e6ba415`).

### Workstream A: Custom Time Picker

`src/components/maintenance/MaintenanceTimePicker.tsx` (new)

- Replaces `input[type="time"]` on all platforms (Android Chrome suppressed native chrome).
- Text input accepts: `"3 PM"`, `"3:00 PM"`, `"3:05 pm"`, `"15:00"`, `"00:00"` → canonical `"HH:mm"`.
- Popover: SVG 12-hour clock face, 4×3 minute grid (5-minute step, configurable), AM/PM toggle, Apply / Cancel, "Now" shortcut.
- Keyboard: Enter confirms valid typed time; Escape closes popover.
- Outside-click closes via `document.addEventListener("mousedown", ...)`.
- Manual entry normalizes on blur; invalid input shows inline error, remains editable.

New helpers in `src/lib/maintenanceDateTime.ts`:
- `parseManualTimeInput(input)` — accepts all formats above, rejects out-of-range values.
- `formatCanonicalTimeForDisplay(value)` — `"15:30"` → `"3:30 PM"`, `"00:00"` → `"12:00 AM"`.
- `normalizeClockTime(hour12, minute, period)` — clock parts → `"HH:mm"`.
- `canonicalTimeToClockParts(value)` — `"HH:mm"` → `{ hour12, minute, period }`.

### Workstream B: Dialog Wiring

`src/components/maintenance/MaintenanceScheduleDialog.tsx` — all three time fields (notice begins, maintenance begins, maintenance ends) now use `MaintenanceTimePicker` instead of `input[type="time"]`.

### Workstream C: Immediate Schedule Display Fix

`src/components/SystemMaintenanceCard.tsx`:
- `applyWriteResult(result)` runs **before** `setScheduleOpen(false)` — optimistic UI is set first.
- `void doLoad()` after write removed.
- Replaced with `reconcileAfterWrite(expectedRevision, windowId, attempt)`:
  - Delays: `[750, 1500, 3000]` ms; max 3 attempts.
  - Accepts if revision matches OR expected window ID found in document.
  - Keeps optimistic state on all 3 mismatches; dev-only `console.debug` on mismatch.

### Workstream D: Background Polling and Transition Refresh

`src/components/SystemMaintenanceCard.tsx`:
- 15-second background polling via `scheduleBgPoll()` (setTimeout chain, pauses when tab hidden).
- In-flight guard (`bgRefreshInFlightRef`) prevents overlapping fetches.
- `scheduleTransitionRefresh(doc)` — fires a one-shot refresh 250 ms after the nearest future `announce_from` / `starts_at` / `ends_at`.
- Visibility / focus / online event listeners trigger immediate refresh.
- State split: `initialLoading` (full skeleton, blocks controls) vs `backgroundRefreshing` (subtle Loader2 spinner in footer).
- `refreshStatus()` from `SystemAvailabilityContext` called after every successful write to update the global banner instantly.

### Workstream E: Edge Config Write Hardening

`api/_lib/edgeConfigWriteConfig.ts` (new):

| Export | Purpose |
|--------|---------|
| `resolveEdgeConfigWriteConfig()` | Tries `VERCEL_API_TOKEN` (trimmed) first, falls back to `EDGE_CONFIG_WRITE_TOKEN`; requires `EDGE_CONFIG_ID`; optional `VERCEL_TEAM_ID` |
| `buildEdgeConfigWriteUrl(config)` | Base URL + `?teamId=...` when configured |
| `mapProviderError(httpStatus)` | Maps 401/403/404/409/429/5xx → `SafeProviderError`; raw body never forwarded |

`api/_lib/edgeConfigSystemStatusStore.ts` updated to use all three new helpers; raw provider response consumed and discarded via `await res.text().catch(() => {})`.

### New Test Files (2026-07-19)

| File | Tests |
|------|-------|
| `src/lib/__tests__/maintenanceDateTimeExtended.test.ts` | 23 — parseManualTimeInput (T1–T9,T13,T14), formatCanonicalTimeForDisplay (T10,T11), clock-parts round-trip (T12) |
| `src/lib/__tests__/edgeConfigWriteConfig.test.ts` | 16 — token resolution (T59), EDGE_CONFIG_ID required (T60), team URL (T61), error mapping (T62–T64) |
| `src/lib/__tests__/maintenanceScheduleBehavior.test.ts` | 31 — validateLocalDateTimeParts (T30–T35), calculateMaintenanceDuration (T36–T38), getScheduleDefaults (T39–T40), combineLocalDateAndTimeToUtcIso (T41–T45), reconcileAfterWrite logic (T46–T52), refreshStatus contract (T53–T58) |
| `src/lib/__tests__/maintenanceRegression.test.ts` | 6 — export surface, null handling, round-trips (T65–T70) |

### Test Results (2026-07-19)

- 83 test files, **1316 tests**, all passing.
- `tsc --noEmit` clean; `npm run typecheck:api` clean; `npm run build` clean.

### Edge Config Readiness Checklist

After Supabase auth is confirmed working in Preview:

- [ ] Link Edge Config store to the Vercel project
- [ ] Confirm `EDGE_CONFIG` is auto-set by Vercel (appears in env vars)
- [ ] Add `EDGE_CONFIG_ID` (store ID, not connection string)
- [ ] Add `EDGE_CONFIG_WRITE_TOKEN` (Vercel API token, not Supabase token)
- [ ] `GET /api/master/maintenance` → `store.provider: "edge_config"`
- [ ] `POST /api/master/maintenance` with `start_manual` → `ok: true`
- [ ] Second `GET` returns the same maintenance state (survived the serverless boundary)
- [ ] Browser refresh → same state persists

### Manual Preview Test Checklist (after all env vars are set)

- [ ] Open Master Admin dashboard
- [ ] Maintenance card shows "Start immediate maintenance" form (not just an error)
- [ ] Scheduler card shows "Scheduled maintenance window" with Schedule button
- [ ] Broadcast card shows "Publish new announcement" form
- [ ] Set title + message → click "Publish Announcement" → success toast
- [ ] Banner appears on next status poll (≤ 60 s) or after `refreshStatus()`
- [ ] Schedule a window → set announce time, start, end → click "Schedule Window" → success
- [ ] Visit as a non-MA user → "Upcoming" banner visible after announce time
- [ ] At start time → users blocked by SystemUnavailableScreen
- [ ] End maintenance → users unblocked without re-login
- [ ] Cancel the window → upcoming state clears
