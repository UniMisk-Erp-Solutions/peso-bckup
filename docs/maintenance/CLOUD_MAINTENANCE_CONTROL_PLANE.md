# PesoWise Cloud Maintenance Control Plane

**Status:** **RELEASE-BLOCKER FIXED AND PROVEN LIVE, MAINTENANCE HISTORY SHIPPED — BLOCKED ON OWNER LIVE LOGIN.** The owner-reported early-unlock bug (a scheduled ~90-minute window ending after ~1 minute) is root-caused, fixed with a trusted in-memory maintenance lease (§34), and proven live end-to-end against the real Cloud project: exact-start/exact-end timers fire with zero manual reload, and a simulated transient Cloud read failure — reproducing the owner's exact bug — no longer drops an active window. Background polling reduced to 120s (was 60s/20s) since it no longer needs to carry transition precision. A full maintenance-history feature shipped: a new Cloud-only migration (schema + atomic trigger-only writes + RLS, `can_view_history` as a permission separate from managing maintenance), a paginated read service, and a reworked admin console with Control/History tabs, summary cards, a monthly downtime chart, filters, and a detail drawer — all proven live against the real project inside safely rolled-back transactions. The public screen gained an original, locally-bundled illustration (reduced-motion aware, zero external assets) and DD/MM/YYYY date formatting throughout. The route-case-hardening gap is fixed. Production remains completely untouched throughout (confirmed via byte-identical `updated_at` before/after every test in this revision). What remains genuinely blocked: this session cannot type the owner's password, so no live Cloud Auth sign-in, dashboard session, or auth-storage-isolation-while-signed-in check has been performed — see §33.7 for exactly what the owner needs to do next. See §31 for the Phase 1 foundation log, §32 for the first real-Cloud verification pass, §33 for admin-authorization/dashboard-V1/live-verification, and §34 for this revision's release-blocker fix, lease architecture, maintenance history, and UX work — including a correction to this document's own original §5 boot-order design (an earlier local-Supabase dependency, `bootstrapAuthSession()` in `src/main.tsx`, was found running BEFORE React even mounted — fixed by moving it into a component only mounted post-decision, not merely reordering provider nesting).
**Branch:** `feature/cloud-maintenance-control-plane` (created from `origin/main`)
**Audience:** anyone who needs to understand, implement, review, or operate this system without prior context.

---

## 1. Executive Summary

PesoWise normally runs on a **self-hosted / local Supabase deployment** for everything the product does:

- Auth (employee/admin login)
- Organizations, employees, roles, hierarchy
- Expenses, reviews, approvals, corrections
- Attachments / receipts
- Balances and transfers
- Form fields, templates, custom field values
- All other application data

That self-hosted Supabase instance runs on infrastructure the owner controls directly (Coolify, per prior session work in this repository) and is sometimes taken offline on purpose — for server maintenance, upgrades, or infrastructure changes.

**The problem this architecture solves:** today, the mechanism meant to tell users "PesoWise is down for maintenance" is itself partially dependent on pieces that are either disabled, or coupled to the same self-hosted Supabase instance that maintenance takes offline. See §3 for the exact, code-verified reasons this doesn't reliably work today.

**The fix:** stand up a second, completely independent Supabase Cloud project used for **exactly one purpose** — telling the browser "PesoWise is in maintenance" or "PesoWise is fine." Nothing else. No PesoWise business data — no organizations, no expenses, no employees, no auth users beyond a short list of maintenance operators — is ever copied into it.

Because this second project is small, free-tier, and used rarely, it is expected to spend most of its life **paused** (Supabase's own free-tier auto-pause behavior). The architecture treats that as normal, not as a failure — see Decision C and Decision D below.

This document is the single source of truth for that system: how it will work, why, what it will and will not depend on, and how it gets built, tested, and rolled back. It does not change any application behavior by existing — see §30 for the readiness checklist that must be worked through before any of this is implemented.

---

## 2. Non-Negotiable Design Decisions

These are binding architecture decisions for this feature. A future implementer should treat deviating from any of these as requiring a new decision record, not a silent choice.

### Decision A — No Vercel API/function dependency for the maintenance *check*

The maintenance **read path** (the thing every visitor's browser evaluates on load) must not use:

- Vercel Serverless/Edge Functions (i.e. no new `/api/*` route)
- Vercel Edge Config as the active control plane
- Supabase Edge Functions

The browser reads maintenance state **directly** from Supabase Cloud's REST/PostgREST endpoint using the publishable (anon) key — no server in between.

Vercel may keep hosting the static React build. That is a static-hosting dependency, not a function/compute dependency, and is explicitly out of scope to remove (see §17, "Frontend host outage").

### Decision B — Two completely separate Supabase systems

| | LOCAL / self-hosted Supabase | Supabase Cloud (this project) |
|---|---|---|
| Purpose | Normal PesoWise application | Maintenance control only |
| Data | All real business data | One status row per environment, one admin allow-list |
| Client | `src/integrations/supabase/client.ts` | `src/integrations/maintenance-cloud/client.ts` (new, §10) |
| Env vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | `VITE_MAINTENANCE_SUPABASE_URL`, `VITE_MAINTENANCE_SUPABASE_PUBLISHABLE_KEY` (new, §9) |
| Migrations | `supabase/migrations/` | `infra/maintenance-cloud/migrations/` (new, §18) |
| Auth | PesoWise employees/admins | A short, separately-maintained maintenance-operator allow-list (§7) |

These must never share a client instance, an env var, a migration directory, or a schema. Cross-use (e.g. reading maintenance state through the local Supabase client, or vice versa) defeats the entire point of the architecture and must be treated as a bug if found in review.

### Decision C — Fail open (critical)

The Cloud maintenance project must **never** become something PesoWise normal operation depends on. If the Cloud request:

- returns a network error,
- times out,
- returns a non-2xx status,
- returns malformed/unexpected JSON,
- or the Cloud project is paused,

then the frontend **continues normal PesoWise operation** — no maintenance screen, no blocking spinner, no degraded mode tied to this failure.

Maintenance must be shown **only** when the frontend receives a **fresh, valid, explicit** Cloud response that says so. See §11 for the full decision table and §12 for why cached data is explicitly excluded from this trust.

### Decision D — The Cloud project may normally sit paused

This is accepted, not tolerated. The steady-state assumption is:

```
Cloud project PAUSED  +  Local PesoWise server HEALTHY  =  PesoWise works normally.
```

Before planned maintenance, the operator:

1. Resumes the Cloud project (Supabase Dashboard).
2. Waits until it responds.
3. Logs into the maintenance admin UI (Cloud Auth — independent of local PesoWise).
4. Schedules or force-enables maintenance.
5. Performs the local-server maintenance.

Full operational sequence: §16.

### Decision E — Maintenance admin auth is independent of local PesoWise auth

A dedicated auth flow, backed by **Supabase Cloud Auth**, is used to control maintenance. It must not call, depend on, or fall back to local Supabase auth. This is the direct fix for the coupling identified in §3.4 (today's `/api/master/maintenance` verifies admins against the *local* Supabase instance — the same instance that maintenance takes offline).

Preferred routes:

```
/admin/maintenance/login
/admin/maintenance
```

The existing PesoWise Master Admin role/UI (`/master`, `MasterAdminDashboard.tsx`) is **not** reused for this. They are different systems with different failure domains.

### Decision F — No browser secret/service-role key, ever

The frontend bundle receives only:

```
VITE_MAINTENANCE_SUPABASE_URL
VITE_MAINTENANCE_SUPABASE_PUBLISHABLE_KEY
```

Never, under any circumstance, in any `VITE_*` variable or any file that ships to the browser:

- `service_role` key
- any Cloud project "secret" API key
- the Cloud database password or connection string

This mirrors the existing convention in this repository (`.env.example` already documents `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` as the only client-side Supabase credentials for the local project — DOC-082's security sweep specifically verified only the anon/publishable key ever reaches the bundle). The same discipline applies to the second project.

---

## 3. Current Architecture Audit

This section documents **what the code actually does today**, verified by direct inspection on `origin/main` at the time this document was written (`bf798862cdd52bc6224de124ff230044831f9aab`). It intentionally does not rely on `Documentations MD/system-status-temporary-disablement.md` (DOC-072) or any other prior doc's prose — those are cross-checked against, not trusted blindly.

### 3.1 File inventory (as found)

| File | Role |
|---|---|
| `src/main.tsx` | React root bootstrap; provider nesting order |
| `src/contexts/SystemAvailabilityContext.tsx` | Polls `/api/system-status`, exposes `state`/`blocking`/`status` via context |
| `src/config/systemStatusFeature.ts` | Client feature flag: `VITE_SYSTEM_STATUS_CONTROL_ENABLED` |
| `src/lib/systemAvailability.ts` | Client-safe types + pure helpers (`isBlockingState`, `formatCountdown`, etc.) |
| `src/App.tsx` | Route table; `GlobalSystemStatusShell` (banner only); `ProtectedRoute` wiring |
| `src/components/ProtectedRoute.tsx` | **Where the actual blocking screen is decided and rendered** |
| `src/components/SystemUnavailableScreen.tsx` | Full-page blocking UI |
| `src/components/SystemAlertBanner.tsx` | Non-blocking top-of-page ticker (upcoming window / announcement) |
| `src/components/SystemMaintenanceCard.tsx` (985 lines) | Master Admin UI: schedule/force maintenance |
| `src/components/SystemBroadcastCard.tsx` | Master Admin UI: broadcast announcements |
| `src/components/maintenance/MaintenanceScheduleDialog.tsx` (455 lines) | Schedule-window dialog |
| `src/components/maintenance/MaintenanceTimePicker.tsx` (524 lines) | Date/time picker used by the dialog |
| `src/lib/maintenanceDateTime.ts` (272 lines) | Pure date/time helpers for the admin UI |
| `src/pages/MasterAdminDashboard.tsx` | Mounts `SystemMaintenanceCard`/`SystemBroadcastCard`, gated by the client flag |
| `api/system-status.ts` | `GET /api/system-status` — Vercel Function, public, crash-safe wrapper |
| `api/_handlers/publicSystemStatusHandler.ts` | Actual read-path logic |
| `api/_lib/systemStatusFeature.ts` | Server feature flag: `SYSTEM_STATUS_CONTROL_ENABLED` (separate from the client flag) |
| `api/_lib/systemStatusEnvironment.ts` | Env-var readiness diagnostics (never leaks values) |
| `api/_lib/systemStatusEvaluator.ts` | Pure state machine: document → public status |
| `api/_lib/systemStatusStore.ts` | Store interface + in-memory implementation + `applyWrite` |
| `api/_lib/edgeConfigSystemStatusStore.ts` | Vercel Edge Config-backed store implementation |
| `api/_lib/edgeConfigWriteConfig.ts` | Edge Config write-credential resolution |
| `api/_lib/systemStatusTypes.ts` | Server-side schema (`SystemStatusDocument`, `PublicSystemStatus`, write payloads) |
| `api/_lib/verifyMasterAdmin.ts` | Master Admin JWT verification **against local Supabase** |
| `api/_lib/supabaseServerConfig.ts` | Resolves local Supabase URL/anon key for server functions |
| `api/master/maintenance.ts` | `GET`/`POST /api/master/maintenance` — Master Admin write endpoint |
| `api/master/announcement.ts` | Broadcast-announcement write endpoint (same pattern) |
| `src/lib/__tests__/systemStatusDisablement.test.ts`, `maintenanceRegression.test.ts`, `maintenanceScheduleBehavior.test.ts`, `maintenanceDateTimeExtended.test.ts`, `systemStatusStore.test.ts`, `systemStatusEvaluator.test.ts` | Test coverage for the above |

Also touched: `src/pages/Dashboard.tsx`, `src/pages/Auth.tsx`, `src/hooks/useDashboardBackendHealth.ts`, `src/lib/backendHealth.ts` (a **separate**, unrelated "is the backend RPC reachable" health chip — not part of the maintenance gate; do not confuse the two).

### 3.2 Current-state diagram (verified against source, not documentation)

```
React app boot (src/main.tsx)
        |
        v
SystemAvailabilityProvider   <-- mounted ABOVE AuthProvider (see 3.3)
        |
        v
  polls GET /api/system-status
  every 60s (15s while blocking), on focus, on visibility, on reconnect
        |
        v
Vercel Serverless Function (api/system-status.ts -> publicSystemStatusHandler.ts)
        |
        v
  reads Edge Config key "system_status"  (NOT Supabase — verified, see 3.5)
        |
        v
  api/_lib/systemStatusEvaluator.ts (pure function) turns the stored
  document into { state, blocking, source, title, message, ... }
        |
        v
  SystemAvailabilityContext exposes { state, blocking, status, ... }
        |
        v
  CONSUMED IN TWO DIFFERENT PLACES, WITH TWO DIFFERENT EFFECTS:
        |
        +---------------------------------------------------+
        |                                                     |
  App.tsx: GlobalSystemStatusShell            ProtectedRoute.tsx (per protected route)
  -> renders SystemAlertBanner ONLY            -> computes maintenanceBlocking =
     (a ticker banner, non-blocking,               !loading && !systemInitializing && blocking
      shown for "upcoming"/announcement)        -> if blocking AND a `user` object exists:
     Mounted for EVERY route, including            - Master Admin on /master: pass through
     "/", "/auth", public marketing pages.          - Master Admin elsewhere: redirect to /master
     Never shows the full-page block.               - anyone else: render SystemUnavailableScreen
                                                  -> if NOT logged in (`!user`): falls through to
                                                     `<Navigate to="/auth" />` — the maintenance
                                                     screen is NEVER shown to a logged-out visitor.
```

### 3.3 Boot order — verified line-by-line from `src/main.tsx`

```tsx
createRoot(...).render(
  <ErrorBoundary fallback={AppErrorFallback}>
    <HelmetProvider>
      <SystemAvailabilityProvider>   {/* <-- above AuthProvider */}
        <AuthProvider>
          <I18nProvider>
            <App />
          </I18nProvider>
        </AuthProvider>
      </SystemAvailabilityProvider>
    </HelmetProvider>
  </ErrorBoundary>
);
```

So the **context provider** genuinely is mounted above `AuthProvider`, exactly as its own top-of-file comment claims ("Must be mounted ABOVE AuthProvider so maintenance gate works before auth resolves"). That part is true and does not need to change.

**What is not true, and is the actual defect**, is where that context's value is *consumed* to decide whether to block:

- `App.tsx`'s `GlobalSystemStatusShell` (mounted above all routes, inside `BrowserRouter`) only renders `SystemAlertBanner` — a small ticker, not a block. `App.tsx` even carries an explicit comment recording that a prior "AuthMaintenanceGate" component was **removed**:

  > `// AuthMaintenanceGate removed: /auth must always be reachable so that Master Admin (and any user who needs to log in) can access the sign-in form during maintenance. Blocking non-admin users after login is handled by ProtectedRoute once the session is established.`

- The actual full-screen `SystemUnavailableScreen` is only ever rendered from inside `ProtectedRoute.tsx`, and only after:
  1. `loading` (local Supabase auth) has finished (`!loading`), **and**
  2. a `user` object exists (`if (maintenanceBlocking && user)`).

  If there is no `user` — i.e. a fresh, logged-out visitor, or anyone whose local-Supabase session cannot be established because the local server is the thing that's down — `ProtectedRoute` falls through to `if (!user) return <Navigate to="/auth" replace />;`. **A logged-out visitor during "maintenance" today sees the normal login page, not a maintenance notice**, because the gate that used to cover `/auth` was deliberately removed and never replaced with a pre-auth version.

### 3.4 Does local Supabase auth/profile loading block the maintenance screen? — **Yes, structurally, by design**

Confirmed from `ProtectedRoute.tsx`:

```tsx
const maintenanceBlocking = !loading && !systemInitializing && blocking;
...
if (maintenanceBlocking && user) {
  if (isMasterAdmin) { ... }
  else { return <SystemUnavailableScreen />; }
}
...
if (!user) {
  return <Navigate to="/auth" replace />;
}
```

Two independent local-Supabase couplings exist today:

1. **The read path requires an already-authenticated user.** `loading` comes from `AuthContext`, which talks to the local Supabase auth service. If that service is slow, unreachable, or the session can't resolve, `loading` may never settle to `false` for that visitor, and even if it does, `user` will be `null` for anyone not already logged in — so the maintenance screen never renders for them at all.

2. **The write/admin path requires local Supabase outright.** `api/_lib/verifyMasterAdmin.ts` authenticates the Master Admin by calling `${supabaseUrl}/auth/v1/user` and querying `profiles`/`master_admin_memberships` — and `supabaseUrl` here is resolved by `api/_lib/supabaseServerConfig.ts` from `SUPABASE_URL`/`VITE_SUPABASE_URL`, i.e. **the local, self-hosted Supabase project** (the same one identified by name in `.env.example`: `VITE_SUPABASE_URL=https://pesowise-supabase.unimisk.com`). If the local server is down for the maintenance this system exists to announce, **the admin cannot authenticate to `/api/master/maintenance` to turn maintenance on or off**, because the very auth check that gates that endpoint depends on the server being maintained.

This second point is the core motivation for Decision E (§2): the new architecture uses Cloud Auth specifically so the admin control path never depends on the thing being maintained.

### 3.5 What the current read path does NOT depend on (and is worth preserving conceptually)

`api/_handlers/publicSystemStatusHandler.ts` carries its own accurate comment:

> "Reads the system_status document from Edge Config and evaluates it using server time. Does NOT contact Supabase, does NOT probe any backend health endpoint. Supabase being unavailable cannot activate maintenance through this endpoint."

This is correct and already the right idea for the *read* path — the current design deliberately avoids querying local Supabase to decide whether maintenance is active. What it depends on instead is a **Vercel Serverless Function** and **Vercel Edge Config**, both of which Decision A explicitly removes from the new design (replaced by a direct Cloud Supabase read from the browser). The admin *write* path (§3.4, point 2) has no equivalent protection today — that's the actual gap.

### 3.6 Current feature-flag / deployment state (verified, not assumed)

Both the client and server flags default to disabled and require the **exact string** `"true"`:

- Client: `SYSTEM_STATUS_CONTROL_ENABLED = import.meta.env.VITE_SYSTEM_STATUS_CONTROL_ENABLED === "true"`
- Server: `isSystemStatusControlEnabled() = process.env.SYSTEM_STATUS_CONTROL_ENABLED === "true"`

`src/pages/MasterAdminDashboard.tsx` renders a `SystemStatusDisabledCard` in place of the real maintenance UI whenever the client flag is off, with this exact copy:

> "Maintenance scheduling and broadcast announcements are temporarily unavailable **while the storage provider is being changed**. No maintenance status is currently being read. No users will be blocked by the maintenance system. Existing implementation has been retained for future reactivation."

This confirms two things directly from the shipped copy: (a) the feature is **currently disabled in the live app** (this is DOC-072's "kill switch," triggered by Edge Config quota pressure, per that doc's own title), and (b) the project has already publicly committed to "the storage provider is being changed" — i.e. this Cloud Supabase architecture is the anticipated successor, not a speculative alternative.

### 3.7 Current schema (Edge Config document, for reference — not reused, see §6)

```ts
type SystemStatusDocument = {
  schema_version: 1;
  revision: string;
  manual_maintenance: { enabled, incident_id, title, message, started_at, estimated_end_at } | null;
  windows: Array<{ id, title, message, starts_at, ends_at, announce_from, status: "scheduled"|"cancelled", created_at, updated_at }>;
  announcement: { id, title, message, published_at, updated_at } | null;
  updated_at: string;
};
```

Precedence in `evaluateSystemStatus()` (pure function, unit-tested): **manual maintenance > active scheduled window > upcoming-announcement-period > operational.** This precedence order is worth preserving conceptually in the new design (§11) even though the storage and transport are being replaced.

---

## 4. Target Architecture

```
                         USER LOADS PESOWISE
                                 |
                                 v
                     STATIC REACT FRONTEND (Vercel-hosted, static only)
                                 |
                                 v
                     MAINTENANCE BOOTSTRAP (new, §5)
                                 |
                                 v
                 SUPABASE CLOUD DIRECT READ (browser -> Cloud PostgREST,
                 publishable key only, timeout-bounded)
                                 |
                 +---------------------------+
                 |                            |
          VALID RESPONSE                   FAILURE
                 |                     / PAUSED / TIMEOUT /
                 |                       NETWORK ERROR /
                 |                       MALFORMED BODY
                 v                            |
        evaluate status                   FAIL OPEN
                 |                            |
        +--------+--------+                   |
        |                 |                   |
     ACTIVE             NORMAL                 |
        |                 |                    |
        v                 +--------------------+
  Maintenance                        NORMAL APP
    Screen                                |
                                          v
                                LOCAL SELF-HOSTED SUPABASE
                              (auth, data, everything PesoWise
                               already does today — unchanged)
```

Independent admin path — never touches local Supabase, never touches the bootstrap above:

```
/admin/maintenance/login
        |
        v
SUPABASE CLOUD AUTH  (separate project, separate credentials, §7)
        |
        v
/admin/maintenance
        |
        v
Cloud maintenance tables (public.maintenance_status, public.maintenance_admins)
        |
        v
Read-back-and-confirm after every write (§15)
```

No step in the admin path requires the local PesoWise Supabase project to be reachable.

---

## 5. Boot Order

This is the section that fixes §3.3/§3.4's actual defect: the maintenance decision must be evaluated, and able to render its own screen, **before** any local-application auth work runs — not merely "the context is created above `AuthProvider`" (which is already true today and did not, by itself, prevent the gap).

### 5.0 CORRECTION (implementation Phase 1) — an earlier local-Supabase dependency than the one this section originally described

This document's original draft of §5 (below) correctly identified that mounting
`AuthProvider` unconditionally was a problem. It did **not** catch a dependency
one step earlier: `src/main.tsx` called `bootstrapAuthSession()` — which
imports `src/integrations/supabase/client.ts` (the LOCAL Supabase client) and
calls `supabase.auth.getUser()` — **before React ever rendered anything**,
racing it against a 1500ms cap and only THEN calling `createRoot().render()`.
Reordering provider nesting inside the React tree could never have fixed this,
because the local-Supabase call was already in flight before there was a React
tree to reorder.

**CURRENT (before this fix):**

```
browser
  -> bootstrapAuthSession()      <-- LOCAL Supabase contacted here, pre-React
  -> LOCAL Supabase
  -> React render
  -> SystemAvailabilityProvider
  -> AuthProvider
```

**TARGET (implemented this revision):**

```
browser
  -> React shell (ErrorBoundary + HelmetProvider)
  -> plain pathname check: is this /admin/maintenance*?
       yes -> MaintenanceAdminApplication (Cloud Auth only, bypasses everything below)
       no  -> MaintenanceBootstrap
                -> Cloud read (fail-open, timeout-bounded)
                -> if ACTIVE:
                     CloudMaintenanceScreen
                     STOP — LocalPesoWiseBootstrap is NEVER mounted
                -> if NORMAL / UPCOMING / any Cloud failure:
                     LocalPesoWiseBootstrap
                       -> bootstrapAuthSession()   <-- now runs HERE, after the decision
                       -> (same 1500ms cap as before)
                       -> AuthProvider -> I18nProvider -> App
```

`bootstrapAuthSession()` itself is unchanged — same stale-refresh-token
cleanup, same invalid-session recovery, same "network failure never signs the
user out" guarantee, same 1500ms cap. Only **when** it runs moved: it is now
inside `src/maintenance/LocalPesoWiseBootstrap.tsx`, which
`src/maintenance/MaintenanceBootstrap.tsx` mounts for every outcome except a
fresh "maintenance" resolution — proven by
`src/maintenance/__tests__/maintenanceBootstrap.test.tsx` and
`src/maintenance/__tests__/localPesoWiseBootstrap.test.tsx`.

`/admin/maintenance*` is decided by a **plain pathname check** on
`window.location.pathname` in `src/main.tsx` — deliberately not a React
Router hook, because this decision happens above any router and must remain
reachable independent of both the maintenance gate and the local application.
`MaintenanceAdminApplication` owns its own `<BrowserRouter>`, safe because it
is mutually exclusive with `App.tsx`'s own `<BrowserRouter>` (exactly one of
the two ever renders per page load) — proven by
`src/maintenance/__tests__/maintenanceAdminIsolation.test.ts`.

Target conceptual tree (original draft, still accurate for the
`MaintenanceBootstrap` half — kept for context):

```tsx
<MaintenanceBootstrap>
  {maintenanceActive ? (
    <SystemUnavailableScreen />
  ) : (
    <LocalPesoWiseApplication />
  )}
</MaintenanceBootstrap>
```

```tsx
function LocalPesoWiseApplication() {
  return (
    <AuthProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </AuthProvider>
  );
}
```

Key difference from today: `<LocalPesoWiseApplication>` (and therefore `AuthProvider`, and therefore any call to local Supabase) is **not mounted at all** while `MaintenanceBootstrap` has a fresh, valid "active" result. Today, `AuthProvider` is always mounted and always starts its local-Supabase session check regardless of maintenance state; only the *routing* layer (`ProtectedRoute`) reacts to it, and only for already-resolved, already-logged-in users. The new design moves the decision a full layer higher, so:

- A logged-out visitor sees the maintenance screen directly — no dependency on reaching `/auth`, no dependency on local Supabase responding at all.
- Local Supabase is never contacted while maintenance is confirmed active (no wasted auth calls against a server that may itself be down).
- `MaintenanceBootstrap` itself must be fail-open per Decision C — an unresolved/uncertain Cloud state renders `<LocalPesoWiseApplication>`, not a block and not an infinite loading state.

Cloud maintenance-admin routes (`/admin/maintenance/login`, `/admin/maintenance`) must be reachable **independently of `MaintenanceBootstrap`'s decision** — an admin needs to reach the login page precisely when maintenance is active. The simplest correct shape is to route those two paths *before* `MaintenanceBootstrap`'s gate is applied, e.g. a small router-level check on `location.pathname` that lets `/admin/maintenance*` through unconditionally, independent of both the Cloud maintenance-status read and of `LocalPesoWiseApplication`/`AuthProvider`. Exact implementation is a Phase 6/7 decision (§24), not fixed here.

---

## 6. Cloud Database Design

**Status: SQL written (`infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql`), not yet applied to any real Cloud project.** The schema below reflects that file exactly, including the §31.3 security improvement (per-environment admin authority) made before the SQL was written.

### 6.1 `public.maintenance_status`

```sql
create table public.maintenance_status (
  environment        text primary key
                        check (environment in ('production', 'preview')),
  force_maintenance   boolean not null default false,
  title               text,
  message             text,
  starts_at           timestamptz,
  ends_at             timestamptz,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id),
  constraint maintenance_status_window_check
    check (
      (starts_at is null and ends_at is null)
      or (starts_at is not null and ends_at is not null and ends_at > starts_at)
    )
);
```

`updated_at`/`updated_by` are never client-writable — see §31.3 for the
`BEFORE UPDATE` trigger that stamps both server-side on every write, and §8
for the column-level grant that makes a client attempt to set them a hard
Postgres permission error, not merely an RLS denial.

**`environment` as PRIMARY KEY vs. enforced UNIQUE:** recommend `PRIMARY KEY`. There are exactly two rows this table will ever hold in V1 (`production`, `preview`), both bootstrapped once and never recreated from the frontend (§8). A primary key on a `check`-constrained text column is simpler than a synthetic `id` + separate `unique` constraint and communicates "this row set is fixed and small" more directly. If a third environment is ever needed, the `check` constraint is the one line to change.

All timestamps are `timestamptz` (UTC-normalized at rest) — never `timestamp`/naive local time (§14).

`ends_at > starts_at` is enforced only when both are present, matching the existing evaluator's own validation logic in spirit (`api/_lib/systemStatusEvaluator.ts`'s `validateWindow`), reimplemented at the database layer since this is a much smaller schema than the current windows-array design and does not need to support multiple simultaneous scheduled windows in V1 (open decision, §27).

### 6.2 `public.maintenance_admins`

```sql
create table public.maintenance_admins (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  is_active              boolean not null default true,
  can_manage_preview     boolean not null default true,
  can_manage_production  boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
```

**Why this table exists, separately from Cloud Auth's own user list:** having a Supabase Cloud Auth *account* must not, by itself, grant any authorization. `auth.users` only proves "this person can sign in to this Cloud project" — it says nothing about whether they're allowed to touch PesoWise's maintenance switch. `maintenance_admins` is the explicit authorization list every RLS policy checks against (§7, §8). No normal PesoWise profile data — no name, no organization, no role beyond "is this Cloud-Auth user allowed to write maintenance state" — belongs in this table.

**`can_manage_preview`/`can_manage_production` (§31.3 security improvement):** the original draft of this table had only `is_active`, meaning any active admin could write either environment's row. Do not rely solely on UI confirmation for Preview/Production write isolation — a Preview-only operator with a valid Cloud session could otherwise bypass the admin UI entirely and mutate Production directly via PostgREST. These two columns are checked in the RLS `UPDATE` policy (§8), not merely displayed in the UI. The owner account may eventually have both `true`.

---

## 7. Cloud Auth Design

Maintenance admins authenticate against **Supabase Cloud Auth**, starting with email/password (Supabase's default). MFA/TOTP is recommended as a hardening phase (§21, §27) rather than a V1 requirement, given the small number of operators and the fact that the blast radius of a compromised session is "can toggle a maintenance banner," not financial data.

**Having a Cloud Auth account does not, by itself, authorize anything.** Every policy that allows a write must independently verify, at query time, both active status AND authority over the specific row's environment:

```sql
exists (
  select 1 from public.maintenance_admins ma
  where ma.user_id = auth.uid()
    and ma.is_active = true
    and (
      (maintenance_status.environment = 'preview' and ma.can_manage_preview = true)
      or (maintenance_status.environment = 'production' and ma.can_manage_production = true)
    )
)
```

If MFA enforcement is adopted later, Supabase's `auth.jwt() ->> 'aal'` (Authenticator Assurance Level) can be checked in the same policy (`aal = 'aal2'`) to require a completed second factor before a write is allowed — this is additive to, not a replacement for, the `maintenance_admins` check above. Recorded as an open decision in §27; do not implement until decided.

---

## 8. RLS / Database Security Model

**Status: written in full, matching `infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql` exactly. Not yet applied to any real Cloud project.**

### `public.maintenance_status`

| Actor | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `anon` (public visitor) | **YES** | NO | NO | NO |
| authenticated Cloud user, not in `maintenance_admins` | YES | NO | NO | NO |
| authenticated Cloud user, active but wrong-environment authority | YES | NO | NO (RLS filters to 0 rows) | NO |
| authenticated Cloud user, `is_active = true` AND authorized for that row's environment | YES | NO (see below) | **YES — column-limited (see below)** | NO |

- `SELECT` is granted to `anon` and `authenticated` unconditionally — the row is intentionally public information (§17, "Public information").
- `INSERT`/`DELETE` have **no grant at all** to `anon` or `authenticated` — blocked at the privilege level, not merely by RLS. The two rows (`production`, `preview`) are created once, directly, by the migration (§6, §24 Phase 2) — never through the frontend.
- `UPDATE` is a **column-level grant**: `authenticated` may write only `force_maintenance, title, message, starts_at, ends_at` — `environment`, `updated_at`, and `updated_by` are excluded from the grant entirely, so including any of them in an `UPDATE` statement is a hard Postgres permission error, before RLS is even evaluated. This is the primary enforcement for "environment mutation: DENY" and "audit fields cannot be client-forged" (§31.3).
- The RLS `UPDATE` policy (on top of the column grant) requires `is_active = true` **and** the matching per-environment authority (`can_manage_preview`/`can_manage_production`, §6.2/§31.3) — both `USING` and `WITH CHECK`, so a Preview-only admin's attempt to write the Production row is filtered to 0 affected rows regardless of what the column grant would otherwise permit.

### `public.maintenance_admins`

This table is **not publicly enumerable** — no `anon` grant at all (not even a policy; the base grant is absent). `authenticated` has `SELECT` only, restricted by RLS to `user_id = auth.uid()` (their own row). No `INSERT`/`UPDATE`/`DELETE` grant to any application role — the allow-list is managed out-of-band (trusted Cloud project administration), per `infra/maintenance-cloud/README.md`.

### Grants and policies — as actually implemented

See `infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql` for the authoritative, complete SQL (reproduced there with full comments explaining each grant). Summary:

```sql
alter table public.maintenance_status enable row level security;
alter table public.maintenance_admins enable row level security;

revoke all on public.maintenance_status from public, anon, authenticated;
grant select on public.maintenance_status to anon, authenticated;
grant update (force_maintenance, title, message, starts_at, ends_at)
  on public.maintenance_status to authenticated;
-- no insert/delete grant, ever

create policy "public can read maintenance status" on public.maintenance_status
  for select using (true);

create policy "authorized active admins can update their environment"
  on public.maintenance_status for update
  using (
    exists (select 1 from public.maintenance_admins ma
            where ma.user_id = auth.uid() and ma.is_active = true
              and ((maintenance_status.environment = 'preview' and ma.can_manage_preview = true)
                or (maintenance_status.environment = 'production' and ma.can_manage_production = true)))
  )
  with check ( /* same condition */ );

revoke all on public.maintenance_admins from public, anon, authenticated;
grant select on public.maintenance_admins to authenticated;
-- no insert/update/delete grant to any application role

create policy "self can read own admin row" on public.maintenance_admins
  for select using (user_id = auth.uid());
```

---

## 9. Environment Variables

| Variable | Scope | Meaning |
|---|---|---|
| `VITE_SUPABASE_URL` | existing, local | Self-hosted PesoWise Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | existing, local | Self-hosted PesoWise Supabase anon key |
| `VITE_MAINTENANCE_SUPABASE_URL` | **new** | Cloud maintenance project URL |
| `VITE_MAINTENANCE_SUPABASE_PUBLISHABLE_KEY` | **new** | Cloud maintenance project anon/publishable key |
| `VITE_MAINTENANCE_ENV` | **new** | `"production"` or `"preview"` — selects which row this deployment reads |
| `VITE_MAINTENANCE_CONTROL_ENABLED` | **new** | Feature kill-switch, default `true` (recommended) |
| `VITE_MAINTENANCE_REQUEST_TIMEOUT_MS` | **new** | Recommended default: **2500–3000 ms** |

Recommended per-deployment values:

```
Preview:     VITE_MAINTENANCE_ENV=preview
Production:  VITE_MAINTENANCE_ENV=production
```

**No service-role key in any `VITE_*` variable, ever** (Decision F). This table is the complete contract for the browser bundle — anything not listed here must not reach the client.

---

## 10. Client Module Separation

```
src/
  integrations/
    supabase/
      client.ts                        <- LOCAL Supabase ONLY (unchanged)

    maintenance-cloud/                 <- NEW, entirely separate
      client.ts                        <- Cloud Supabase client (publishable key only)
      types.ts                         <- MaintenanceStatusRow, etc.
      maintenanceStatusService.ts      <- read (public) + update (admin) calls
      maintenanceAdminService.ts       <- Cloud Auth sign-in/sign-out for admins

  maintenance/                         <- NEW
    MaintenanceBootstrap.tsx           <- the gate described in §5
    MaintenanceGate.tsx                <- pure decision component (state -> render)
    maintenanceResolver.ts             <- pure fetch+evaluate+fail-open logic (unit-testable, no React)

  pages/
    maintenance-admin/                 <- NEW
      MaintenanceAdminLogin.tsx
      MaintenanceAdminDashboard.tsx
```

Naming discipline: `supabase` always means the local client; a new symbol name — e.g. `maintenanceSupabase` — is used everywhere for the Cloud client, so a reviewer can `grep` for accidental cross-use. No file under `src/integrations/maintenance-cloud/` may import from `src/integrations/supabase/`, and no file under `src/integrations/supabase/` may import from `src/integrations/maintenance-cloud/`. This should be enforced by import-boundary review (and optionally an eslint `no-restricted-imports` rule) once implemented — not required for this artifact.

---

## 11. Maintenance State Machine

This is a contract, not a suggestion. Every row is either a currently-testable behavior (§23) or must be treated as a bug if violated.

| # | Cloud request result | Data condition | Result |
|---|---|---|---|
| 1 | succeeds | `force_maintenance = true` | **MAINTENANCE** |
| 2 | succeeds | `force_maintenance = false`, `starts_at <= now < ends_at` | **MAINTENANCE** |
| 3 | succeeds | maintenance scheduled in the future | NORMAL APP (+ optional upcoming banner) |
| 4 | succeeds | schedule expired (`now >= ends_at`) | NORMAL APP |
| 5 | Cloud project paused | — | NORMAL APP (fail open) |
| 6 | timeout | — | NORMAL APP (fail open) |
| 7 | network error | — | NORMAL APP (fail open) |
| 8 | malformed/invalid response body | — | NORMAL APP (fail open) |
| 9 | credentials/config missing (`VITE_MAINTENANCE_*` unset) | — | NORMAL APP (fail open) + developer diagnostic in non-production only |

Row 1 (`force_maintenance`) takes precedence over the schedule window (row 2/3/4) — a force-toggle is meant as an immediate override an admin can flip without touching the schedule fields, mirroring the current system's own `manual_maintenance` > `windows[]` precedence (§3.7).

---

## 12. Caching Rule

Cached maintenance data (however it's obtained — local component state, `localStorage`, `sessionStorage`, an in-memory ref) may be used for:

- reducing UI flicker between polls,
- showing a last-known informational schedule (e.g. "maintenance was scheduled to start at 2am" while a fresh check is in flight),
- debugging/diagnostics.

It must **never** be sufficient, on its own, to activate the blocking maintenance screen. Only a fresh, valid Cloud response (this poll cycle, not a remembered one) may set `maintenanceActive = true`. This is the direct enforcement mechanism for Decision C: if it were otherwise, a Cloud project pause immediately after a maintenance window would leave the last cached "active" value stuck forever, permanently locking out PesoWise — exactly the failure mode this whole architecture exists to prevent.

---

## 13. Polling / Request Strategy

No Realtime subscription in V1 (§26). Proposed strategy, modeled on the existing `SystemAvailabilityContext`'s already-working pattern (§3, immediate + focus + visibility + reconnect + interval) but retargeted at the Cloud endpoint:

- Immediate request on `MaintenanceBootstrap` mount.
- Refresh on `window focus`.
- Refresh on `navigator online` (reconnect).
- Background refresh every **60–120 seconds** (exact value: open decision, §27) while in the normal (non-blocking) state.
- Once a valid `starts_at`/`ends_at` window has been fetched, use a local browser timer to trigger the UI transition at the right moment (mirrors the existing `scheduleTransitionRefresh` pattern in `SystemAvailabilityContext.tsx`) — but **always** re-verify against a fresh Cloud read at that moment rather than trusting the timer's own data, so a cancelled window doesn't still flip the UI.
- Every request is timeout-bounded (`VITE_MAINTENANCE_REQUEST_TIMEOUT_MS`, §9) and aborts cleanly via `AbortController`.
- No request storms: a single in-flight-request guard (abort the previous request before starting a new one, same pattern as the existing context's `abortRef`) prevents overlapping polls from focus+visibility+timer firing close together (tested explicitly in §23, Test J).

---

## 14. Time Handling

- All `maintenance_status` timestamps are stored as `timestamptz` (UTC internally) — never a naive local timestamp.
- All UI display converts to the viewer's local timezone at render time (`Date` / `Intl` formatting, matching the existing `SystemUnavailableScreen`/`SystemAlertBanner` pattern of `new Date(iso).toLocaleString()`).
- Device clock drift is a known limitation of any client-evaluated "is it time yet" check. The existing `SystemAvailabilityContext` already computes a `serverOffset` from a `server_now` field returned by the API and uses it to correct scheduling math; the Cloud read path should adopt the same pattern if/when precision matters (optionally capture Cloud's own server time via a lightweight `now()` read or a Postgres function, rather than trusting `Date.now()` alone) — recorded as available prior art, not mandated for V1.

---

## 15. Maintenance Admin UI

### Status display

```
Current Status:  NORMAL | SCHEDULED | MAINTENANCE ACTIVE
```

### Controls

- **Force Maintenance** toggle (maps to `force_maintenance`).
- **Schedule**: start date/time, end date/time, title, message.
- Buttons: **Save Schedule**, **Cancel Schedule**, **Enable Maintenance**, **Disable Maintenance**.

### Danger confirmation (required before any production-affecting write)

```
Enable maintenance for Production?

Users will be prevented from entering PesoWise.

[Cancel]                          [Enable Maintenance]
```

### Read-back-and-confirm (required after every write)

After any write, the UI must re-`SELECT` the row it just wrote and display the **actual persisted values**, not the optimistic form state — never show "Saved" based on a write call returning `200`/no error alone. This mirrors an existing, deliberate pattern already used elsewhere in this codebase for financial-adjacent writes (e.g. the Manager Override / bulk-approve confirmation flows verify server state rather than trusting the client's own optimistic view) and is worth carrying into this feature for the same reason: a stale or wrong "success" message on a maintenance toggle is exactly the kind of small trust-eroding bug that compounds during an already-stressful maintenance window.

The existing `SystemMaintenanceCard.tsx`/`MaintenanceScheduleDialog.tsx`/`MaintenanceTimePicker.tsx` (985+455+524 lines) are a large, already-built reference for this UI's shape and interaction patterns against the *old* schema — worth reviewing for reusable UX patterns (date/time picker behavior, validation messaging) even though the new implementation targets a different (much smaller) schema and a different (Cloud) backend.

---

## 16. Cloud Project Pause Workflow

**Normal days:** Cloud project may be paused. PesoWise continues normally (Decision D).

**Planned maintenance:**

1. Open the Supabase Dashboard.
2. Resume the Cloud maintenance project.
3. Verify the project responds (e.g. a simple read against `maintenance_status`).
4. Open `/admin/maintenance/login`.
5. Authenticate using Cloud Auth.
6. Configure maintenance (force-enable, or schedule a window).
7. Verify the Cloud state was actually persisted (read-back, §15).
8. Wait for the scheduled start, or rely on the force toggle taking effect on the next poll cycle.
9. Verify the maintenance screen actually renders for a real/incognito visitor.
10. Shut down the local Supabase/server.
11. Perform the local-server maintenance.
12. Bring the local server back up.
13. Verify local PesoWise health (normal login, a normal page load).
14. Disable maintenance, or let the schedule expire on its own.
15. Verify the application resumes normally for a fresh visitor.

The Cloud project may then pause again naturally (Supabase's own free-tier inactivity pause) — no action required.

---

## 17. Failure Scenarios / Limitations

- **Cloud project paused.** Intentional fail-open (Decision C/D) — normal PesoWise continues.
- **Cloud Supabase outage while Local works.** Normal PesoWise continues; nobody sees a maintenance screen they shouldn't.
- **Cloud outage while maintenance is genuinely active AND Local is down.** A newly-loaded browser in this exact combination will fail open into the normal app shell, then encounter local-backend failures directly (failed API calls, spinners, etc.) rather than a clean maintenance message. This is the explicit trade-off Decision C accepts: we chose "never wrongly lock someone out" over "never show a confusing error in this narrow double-outage window." Recorded as an accepted risk, not a bug to silently work around.
- **Unexpected local server crash (not planned maintenance).** The Cloud control plane has no way to know this happened automatically — it only reflects what an admin explicitly set. This architecture handles **planned/forced** maintenance, not automatic outage detection. An external health monitor is explicitly out of scope for V1 (§26) and would be a natural V2.
- **Frontend host (Vercel static hosting) outage.** If Vercel's static hosting itself is down, the React bundle cannot load at all, so neither the normal app nor the Cloud-driven maintenance screen can render. Decision A removes the Vercel *function/compute* dependency for the maintenance check — it does not, and cannot, remove the static-hosting dependency for shipping the React app in the first place. If eliminating that too is ever required, it implies mirroring the static bundle elsewhere, which is out of scope here.
- **Public information.** Maintenance title/time/message is intentionally publicly readable (anon `SELECT`, §8). Operators must never put sensitive infrastructure detail (server names, credentials, internal URLs) in a maintenance message.
- **Free tier pausing.** Accepted by design (Decision D), not a defect.
- **Separate auth.** Cloud maintenance-admin credentials are deliberately separate from PesoWise credentials — an operator needs a second login to remember. This is the direct cost of Decision E's independence guarantee.
- **Two Supabase projects, one operational risk.** Running two separate Supabase projects side by side creates a real risk of an operator or a future contributor confusing LOCAL vs CLOUD configuration (pointing a script or an env var at the wrong project). Naming discipline (`maintenanceSupabase` vs `supabase`, §10), a fully separate migrations directory (§18), and a fully separate env-var namespace (§9) are the mitigations; there is no code-level enforcement beyond that in V1.

---

## 18. Migration Directory Separation

Cloud maintenance SQL must **not** go into `supabase/migrations/` — that directory is the self-hosted PesoWise database's migration history and is scanned by `scripts/check-migration-duplicates.mjs`/`npm run migrations:check` for that project specifically. Mixing in Cloud-only SQL would corrupt that tooling's assumptions and could get accidentally applied to the wrong project by a future `supabase db push`.

Proposed layout:

```
infra/
  maintenance-cloud/
    README.md                                            <- big warning, see below

    migrations/
      001_create_maintenance_control_plane.sql

    rollbacks/
      001_create_maintenance_control_plane_ROLLBACK.sql
```

`README.md` must state, prominently, at the top:

> **These scripts target the separate Supabase Cloud maintenance project ONLY.**
> **Do NOT run them against the self-hosted PesoWise database.**
> **They are not tracked by `npm run migrations:check` and are not part of `supabase/migrations/`.**

Nothing in this directory is applied by this task (§ "AFTER CREATING THE ARTIFACT" instructions — this artifact only).

---

## 19. Existing Edge Config / Vercel Code — Retirement Plan (later, not now)

The old implementation is **not deleted** as part of standing up the new one. Sequence:

1. Build and fully test the new Cloud path (Phases 1–11, §24).
2. Only after it passes every acceptance test in §23, retire:
   - `/api/system-status` as an *active dependency* (the route itself, `api/_handlers/publicSystemStatusHandler.ts`, the Edge Config read).
   - The Edge Config `system_status` store (`api/_lib/edgeConfigSystemStatusStore.ts`, `api/_lib/edgeConfigWriteConfig.ts`).
   - The old Vercel Master Admin write path (`api/master/maintenance.ts`, `api/_lib/verifyMasterAdmin.ts`'s use for this purpose specifically — that helper may still be used elsewhere for actual Master Admin features, verify before touching).
3. Delete only once no references remain — verified by `grep`, not by memory.

**Candidate files for later removal** (do not touch in this task):

```
api/system-status.ts
api/_handlers/publicSystemStatusHandler.ts
api/_lib/edgeConfigSystemStatusStore.ts
api/_lib/edgeConfigWriteConfig.ts
api/_lib/systemStatusFeature.ts        (server flag — retire once nothing reads it)
api/_lib/systemStatusEnvironment.ts    (Edge Config-specific portions)
api/master/maintenance.ts
src/contexts/SystemAvailabilityContext.tsx
src/config/systemStatusFeature.ts      (client flag — retire once nothing reads it)
src/components/SystemUnavailableScreen.tsx   (superseded by the new maintenance screen, or reused — TBD at implementation time)
src/components/SystemAlertBanner.tsx
src/components/SystemMaintenanceCard.tsx
src/components/maintenance/MaintenanceScheduleDialog.tsx
src/components/maintenance/MaintenanceTimePicker.tsx
src/lib/maintenanceDateTime.ts
src/lib/systemAvailability.ts
```

`api/_lib/systemStatusEvaluator.ts`, `api/_lib/systemStatusTypes.ts`, and `api/master/announcement.ts` (broadcast announcements — a separate feature from maintenance blocking, per its own comment) are **not** necessarily retirement candidates; confirm scope before touching any of them.

---

## 20. Preview / Production Isolation

Mandatory. Two fixed Cloud rows: `preview`, `production` (§6.1). Each Vercel deployment target sets its own `VITE_MAINTENANCE_ENV` (§9):

```
Preview:     VITE_MAINTENANCE_ENV=preview
Production:  VITE_MAINTENANCE_ENV=production
```

The maintenance read/write path always filters by this value — a Preview deployment must never be able to read or (for an admin) write the `production` row by accident, and vice versa. This must be proven by an explicit test (§23, Test D), not assumed from the `WHERE environment = ...` clause alone — a UI bug that lets an admin pick the wrong environment in a dropdown would defeat this at the application layer even with correct SQL.

---

## 21. Security Threat Model

| Threat | Expected outcome |
|---|---|
| Attacker obtains the publishable key | Expected / harmless by itself — it's meant to be public, same as the existing local-Supabase publishable key already shipped in the bundle today. |
| Attacker attempts `UPDATE` as `anon` | RLS denies (no update policy for `anon`, §8). |
| Attacker creates an ordinary Cloud Auth account | Not present in `maintenance_admins` → `UPDATE` denied. |
| A `maintenance_admins` row exists but `is_active = false` | `UPDATE` denied — deactivation must be effective immediately, not just cosmetic. |
| Cross-environment write attempt (an active admin tries to write `production` while intending `preview`, or vice versa) | RLS alone cannot distinguish "wrong environment" from "right environment" for an otherwise-authorized admin — this is a UI/workflow risk, not purely a database one. Mitigate at the UI layer: require the danger-confirmation dialog (§15) to name the environment explicitly, and consider requiring the admin to type the environment name to confirm a Production write (pattern already used elsewhere for destructive confirmations in this codebase). |
| XSS on the maintenance-admin page steals an authenticated admin session | High impact — an attacker could toggle maintenance on/off at will. Mitigations: MFA (§7, §27), short session lifetime, explicit logout, and keeping the admin page free of any third-party or unrelated dynamic content that could be an XSS vector. |
| Secret/service-role key leakage | Must never occur — the browser bundle never receives one (Decision F, §9). If this is ever found in a build, treat it as a P0 security incident per this repository's existing `CLAUDE.md` sensitive-data rules. |

---

## 22. Auditability

Recommendation: **V1 required, kept minimal.** `maintenance_status.updated_by` (references `auth.users`) and `updated_at` are already part of the core schema (§6.1) and cost nothing extra to maintain — they answer "who last touched this and when" without a separate table.

A dedicated `maintenance_audit_log` table (recording each discrete `enabled`/`disabled`/`scheduled`/`cancelled` event as its own row, preserving history across overwrites) is recommended as **V2, optional** — genuinely useful for a post-incident timeline, but not required to make the feature safe or correct, and adds a second table's worth of RLS/schema surface to get right before this is even implemented once. Do not build it in V1.

---

## 23. Acceptance Tests

**Test A — Cloud paused.** Cloud: PAUSED. Local: UP. Expected: PesoWise starts normally; no maintenance page; no permanent loading spinner; no auth disruption caused by the maintenance check.

**Test B — Maintenance active, Local down.** Cloud: UP, maintenance ACTIVE. Local: DOWN. Expected: maintenance page loads; refresh works; incognito works; another device works; local Supabase is never required to render the maintenance screen.

**Test C — Maintenance admin, Local down.** Same conditions as B. Open `/admin/maintenance/login`. Expected: Cloud Auth works; the maintenance dashboard loads; maintenance configuration can be modified without local Supabase.

**Test D — Preview isolation.** Preview maintenance: ON. Production: OFF. Expected: Preview shows maintenance only; Production stays normal.

**Test E — Public security.** `anon`: `SELECT` works; `INSERT`/`UPDATE`/`DELETE` all denied.

**Test F — Non-admin Cloud user.** Login succeeds; `UPDATE` on `maintenance_status` denied.

**Test G — Active admin.** Login succeeds; `UPDATE` works; read-back matches what was written.

**Test H — Cloud timeout.** The maintenance Cloud request is intentionally broken/blocked. Expected: normal PesoWise continues within the configured timeout — no indefinite spinner.

**Test I — Schedule transitions.** Future window → upcoming banner (if implemented, §27). At `starts_at` → maintenance. At `ends_at` → normal app, without requiring a manual refresh (background poll picks it up within one interval).

**Test J — Request storm.** Rapidly trigger focus/visibility/reconnect events in succession. Expected: no overlapping/duplicate Cloud requests (single in-flight guard holds, §13).

---

## 24. Implementation Phases

Each phase below is a future-work outline — **none of it is implemented by this artifact.**

| Phase | Goal | Files likely touched | Tests | Rollback point |
|---|---|---|---|---|
| 0 | Current-architecture audit | none (docs only) | none | n/a — this document |
| 1 | Create Cloud Supabase project manually | none (external) | manual verification | delete the Cloud project |
| 2 | Apply Cloud-only schema/RLS | `infra/maintenance-cloud/migrations/001_*.sql` | SQL applies cleanly against a fresh Cloud project | run the paired rollback script |
| 3 | Maintenance Cloud client | `src/integrations/maintenance-cloud/client.ts`, `types.ts` | unit: client construction, env-var validation | revert the commit; no runtime effect until consumed |
| 4 | Direct read service | `maintenanceStatusService.ts`, `maintenanceResolver.ts` | unit: state-machine table (§11) against mocked responses | revert the commit |
| 5 | Fail-open bootstrap | `MaintenanceBootstrap.tsx`, `MaintenanceGate.tsx` | Tests A, H | `VITE_MAINTENANCE_CONTROL_ENABLED=false` (§25) |
| 6 | Move the gate above local Auth | `src/main.tsx` (or equivalent) | Test B (with a real logged-out visitor) | revert the boot-order commit |
| 7 | Cloud maintenance login | `MaintenanceAdminLogin.tsx`, `maintenanceAdminService.ts` | Test F, Test G (auth portion) | route removal / feature-flag the route |
| 8 | Maintenance dashboard | `MaintenanceAdminDashboard.tsx` | Test G (full), UI smoke | route removal |
| 9 | Preview environment integration | env vars in Vercel Preview config | Test D | env var revert |
| 10 | Security/RLS tests | test suite additions under whichever test runner covers this area | Tests E, F, G | n/a (tests only) |
| 11 | Local-server-offline simulation | none (manual/staging exercise) | Tests A, B, C end-to-end | n/a (exercise only) |
| 12 | Production configuration | Vercel env vars, Cloud production row bootstrap | Test D (production leg) | env var revert; `force_maintenance=false` |
| 13 | Retire old Vercel API/Edge Config path | files listed in §19 | full regression suite | git revert of the retirement commit |
| 14 | Documentation / operational runbook finalization | this document + any ops runbook | n/a | n/a |

---

## 25. Rollback Strategy

**Application-level rollback (fastest, no code change):**

```
VITE_MAINTENANCE_CONTROL_ENABLED=false
```

...then redeploy. This bypasses Cloud maintenance control entirely — `MaintenanceBootstrap` should treat a disabled flag exactly like Decision C's fail-open path (render `<LocalPesoWiseApplication>` unconditionally, zero Cloud requests), mirroring how the existing `SYSTEM_STATUS_CONTROL_ENABLED` flag already behaves today (§3.6).

**Code-level rollback:** restore/re-enable the old Edge Config-based implementation (§19) if the new system needs to be backed out entirely, not just disabled.

**Cloud data rollback:** set `force_maintenance = false` and clear the schedule fields (`starts_at`/`ends_at` to `null`) directly on the affected environment's row.

**Cloud schema rollback:** documented and scripted separately under `infra/maintenance-cloud/rollbacks/` (§18) — never mixed with the application-level or code-level rollback steps above.

---

## 26. What We Are Explicitly Not Building Yet

- Automatic unexpected-outage detection
- An external public status page
- Vercel Functions for the maintenance check (Decision A)
- Supabase Edge Functions
- Realtime maintenance subscriptions (polling only, §13)
- A Cloud copy of PesoWise business data
- A Cloud copy of local PesoWise users
- Complex multi-window scheduling (more than one active/upcoming window at a time)
- Mobile push notifications
- Automatic Cloud project resume
- Automatic Cloud project pause
- Automatic shutdown of the local server
- A full disaster-recovery architecture

All of the above are legitimate future work; none are required for this feature to be correct and safe.

---

## 27. Open Decisions — LOCKED (owner decision, implementation Phase 1)

The owner resolved all eight items below for the first working release. Kept
in table form for the historical record of what was considered; the
"Recommendation" column is now the **decided** value, not a suggestion.

| # | Decision | Options | **Locked decision** | Status |
|---|---|---|---|---|
| 1 | MFA for maintenance admins | Required now / V2 | **V2 — not required for first working release** | LOCKED |
| 2 | `maintenance_audit_log` table | V1 / V2 | **V2 — V1 uses `updated_at`/`updated_by` only** (both now server-derived via trigger, never client-forged — see §31.3) | LOCKED |
| 3 | Background poll interval | 60s / 120s | **60 seconds while the Cloud control plane is healthy** (implemented in `maintenanceConfig.ts` as `MAINTENANCE_POLL_INTERVAL_NORMAL_MS`) | LOCKED |
| 4 | Request timeout | 2500ms / 3000ms | **2500ms initially** (`MAINTENANCE_REQUEST_TIMEOUT_MS` default) | LOCKED |
| 5 | Route naming | as proposed / alternative | **`/admin/maintenance/login` and `/admin/maintenance`, as proposed** | LOCKED |
| 6 | Upcoming-maintenance banner | show / don't show | **YES** — implemented as `CloudUpcomingBanner.tsx`, a small Cloud-only component, deliberately NOT built on the old `SystemAlertBanner`/`SystemAvailabilityContext` pair | LOCKED |
| 7 | How far ahead "upcoming" maintenance announces | configurable / fixed | **V1 remains one schedule per environment** — no separate `announce_from` field; "upcoming" is simply "a fresh valid row has a future `starts_at`" (see §11 state machine) | LOCKED |
| 8 | Single row vs. windows table per environment | single row / windows table | **Single row per environment for V1** — no multi-window scheduler | LOCKED |

Also locked, not previously listed as a numbered open decision but confirmed
during Phase 1:

- **No Supabase Realtime** — polling only (§13/§19).
- **No Vercel Function, no Supabase Edge Function** — the browser reads Cloud
  directly (Decision A), confirmed unchanged.
- **No automatic local-outage detection** — this remains a planned/forced
  maintenance control plane only (§17).

---

## 28. Current Code → Target Code Mapping

| Current file | Current responsibility | Target responsibility | Action |
|---|---|---|---|
| `src/contexts/SystemAvailabilityContext.tsx` | Polls `/api/system-status`, exposes state via React context | Superseded by `MaintenanceBootstrap`/`maintenanceResolver.ts` reading Cloud directly | RETIRE LATER (§19) |
| `src/config/systemStatusFeature.ts` | Client flag for the old feature | Superseded by `VITE_MAINTENANCE_CONTROL_ENABLED` | RETIRE LATER |
| `src/lib/systemAvailability.ts` | Client-safe types/helpers for the old schema | Superseded by `maintenance-cloud/types.ts` | RETIRE LATER |
| `api/system-status.ts` | Public read endpoint (Vercel Function) | No equivalent — browser reads Cloud directly (Decision A) | RETIRE LATER |
| `api/_handlers/publicSystemStatusHandler.ts` | Read-path logic (Edge Config) | No equivalent | RETIRE LATER |
| Edge Config `system_status` store (`edgeConfigSystemStatusStore.ts`, `edgeConfigWriteConfig.ts`) | Persistence for the old document | Superseded by `public.maintenance_status` (§6) | RETIRE LATER |
| `api/master/maintenance.ts` | Master Admin write endpoint, auth'd against **local** Supabase | Superseded by direct Cloud writes, auth'd against **Cloud** Supabase (Decision E) | RETIRE LATER |
| `src/components/ProtectedRoute.tsx` | Currently the *only* place the blocking screen renders, post-auth only | Maintenance decision moves above this entirely (§5); `ProtectedRoute` no longer needs its own maintenance branch | MODIFY (remove the now-redundant gate once §24 Phase 6 lands) |
| `src/main.tsx` / provider root | `SystemAvailabilityProvider` above `AuthProvider`, but nothing consumes it pre-auth | `MaintenanceBootstrap` gates `LocalPesoWiseApplication` (incl. `AuthProvider`) entirely | MODIFY |
| `src/components/SystemUnavailableScreen.tsx` | Full-page blocking UI for the old schema/state shape | Either adapted to the new (much simpler) status shape, or replaced | MODIFY or REPLACE (decide at implementation time) |
| `src/components/SystemAlertBanner.tsx` | Non-blocking upcoming/announcement ticker | If the "upcoming" banner (open decision §27.6) is kept, this is the closest prior art | MODIFY or REPLACE |
| `src/pages/MasterAdminDashboard.tsx` (maintenance section), `SystemMaintenanceCard.tsx`, `maintenance/MaintenanceScheduleDialog.tsx`, `maintenance/MaintenanceTimePicker.tsx`, `lib/maintenanceDateTime.ts` | Master Admin scheduling UI, gated by the old flag, currently disabled in production (§3.6) | Superseded by `/admin/maintenance` (Cloud-authed, separate route) | RETIRE LATER (UX patterns may be reused, code itself superseded) |
| `api/master/announcement.ts` | Broadcast announcements (separate from maintenance blocking) | Out of scope — not part of this architecture unless explicitly folded in later | KEEP (until a separate decision is made) |
| `api/_lib/systemStatusEvaluator.ts`, `systemStatusTypes.ts` | Pure state-machine logic + schema for the old document | Conceptual precedence rules (manual > scheduled > upcoming > operational) carried into the new, much simpler evaluator | RETIRE LATER (logic pattern reused, code superseded) |

---

## 29. Final Checklist

## Implementation Readiness Checklist

- [x] Current architecture audited (§3)
- [ ] Cloud project created
- [ ] Cloud URL/key available
- [ ] Preview row created *(SQL written and ready — `infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql` — not yet applied to any real project)*
- [ ] Production row created *(same file, not yet applied)*
- [ ] Maintenance admin created
- [ ] RLS verified *(policies + column grants written and documented in `SECURITY_TEST_CHECKLIST.sql`; not yet run against a real project)*
- [ ] Direct read works *(code exists and is unit-tested against mocks — `fetchMaintenanceStatus`; not yet exercised against a real Cloud project)*
- [x] Fail-open verified *(unit-tested exhaustively — every `MaintenanceReadOutcome` failure kind — `maintenanceResolver.test.ts`, `maintenanceBootstrap.test.tsx`)*
- [x] Pre-auth gate verified *(`bootstrapAuthSession` proven NOT called while a fresh Cloud read says maintenance is active — `maintenanceBootstrap.test.tsx`; proven to run correctly otherwise — `localPesoWiseBootstrap.test.tsx`)*
- [ ] Cloud admin login verified *(code exists; needs a real Cloud project + real admin account to exercise end-to-end)*
- [ ] Local server offline test verified *(needs a real deployment; not simulable in the unit-test suite alone)*
- [ ] Preview isolation verified *(needs two real Cloud rows + two real deployments)*
- [ ] Production smoke verified
- [x] Old Vercel path retired — **NO, deliberately not yet** (§19/§24: retire only after the new path passes offline QA against a real Cloud project — this checkbox is intentionally unchecked until then)
- [ ] Operational runbook complete *(§16 covers the steady-state workflow; needs a final pass once a real Cloud project exists to confirm every step is accurate)*

---

## 31. Phase 1 Implementation Log (this revision)

**What changed:** frontend code, the pure resolver/state-machine, the Cloud
client modules, the maintenance-admin routing foundation, and the Cloud SQL
(schema + RLS + grants + audit trigger) now exist on
`feature/cloud-maintenance-control-plane`. As of revision recorded in §32, a
real owner-provided Cloud project now exists and the schema has been applied
and verified against it (Preview environment only). Production remains
untouched. See §32 for the full verification record.

### 31.1 Architecture correction

See §5.0 above — `bootstrapAuthSession()` was found running in `src/main.tsx`
**before React rendered anything at all**, a dependency one step earlier than
this document's original §5 draft accounted for. Fixed by moving the call
(not deleting or changing its behavior) into `LocalPesoWiseBootstrap.tsx`,
which is only ever mounted after the Cloud maintenance decision resolves to
something other than an active block.

### 31.2 Decisions locked

All eight items in the original §27 table, plus three unlisted defaults, are
now locked — see the rewritten §27 above for the full table.

### 31.3 Security improvement over the original draft schema

The original §6/§8 draft proposed `maintenance_admins(user_id, is_active)`
with no per-environment authority — any active admin could write either
environment's row. Before writing real SQL, this was strengthened to add
`can_manage_preview`/`can_manage_production` booleans, and the RLS UPDATE
policy's `USING`/`WITH CHECK` clauses now require the matching authority for
the specific row's `environment`. This closes a real gap: without it, a
Preview-only operator could bypass the admin UI entirely and mutate
Production directly via PostgREST, since RLS — not the UI — is the actual
security boundary. §6/§8 above reflect this corrected schema; the original,
simpler proposal is not preserved separately since it was never applied
anywhere and superseding it in place avoids two conflicting "current" schemas
coexisting in the same document.

Also implemented, per the same review: `updated_at`/`updated_by` are
**never** client-writable (excluded from the column-level `UPDATE` grant
entirely — a Postgres permission error, not merely an RLS denial, if a client
attempts to include them) and are instead stamped by a `BEFORE UPDATE`
trigger (`maintenance_status_set_audit_fields()`, `SECURITY INVOKER` — not
`DEFINER`, since `auth.uid()`/`now()` need no elevated privilege and the
function touches nothing the invoking, already-RLS-authorized role could not
already touch — documented in the function's own SQL comment and in
`infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql`).

### 31.4 Files added

**Frontend:**
- `src/integrations/maintenance-cloud/client.ts`, `types.ts`,
  `maintenanceStatusService.ts`, `maintenanceAdminService.ts`
- `src/maintenance/maintenanceConfig.ts`, `maintenanceResolver.ts`,
  `MaintenanceBootstrap.tsx`, `LocalPesoWiseBootstrap.tsx`,
  `MaintenanceAdminApplication.tsx`, `CloudMaintenanceScreen.tsx`,
  `CloudUpcomingBanner.tsx`
- `src/pages/maintenance-admin/MaintenanceAdminLogin.tsx`,
  `MaintenanceAdminDashboard.tsx` (foundation-pass placeholder per §22 — no
  write controls yet)

**Tests:**
- `src/maintenance/__tests__/maintenanceResolver.test.ts`,
  `maintenanceBootstrap.test.tsx`, `localPesoWiseBootstrap.test.tsx`,
  `maintenanceAdminIsolation.test.ts`, `isMaintenanceAdminPath.test.ts`
- `src/integrations/maintenance-cloud/__tests__/maintenanceStatusService.test.ts`

**Modified:**
- `src/main.tsx` — no longer calls `bootstrapAuthSession()` directly; renders
  a plain-pathname-check `Root()` choosing `MaintenanceAdminApplication` or
  `MaintenanceBootstrap`.
- `.env.example` — new "Cloud maintenance control plane" section, clearly
  separated from the existing local-Supabase section.
- `src/vite-env.d.ts` — typed the five new `VITE_MAINTENANCE_*` variables.

**Cloud infra (not yet applied anywhere):**
- `infra/maintenance-cloud/README.md`,
  `infra/maintenance-cloud/SECURITY_TEST_CHECKLIST.sql`,
  `infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql`,
  `infra/maintenance-cloud/rollbacks/001_create_maintenance_control_plane_ROLLBACK.sql`

**Untouched, kept as rollback/reference (§19/§24):** every old
`SystemAvailabilityContext`/`SystemUnavailableScreen`/`SystemAlertBanner`/
`api/system-status.ts`/`api/master/maintenance.ts`/Edge Config file. The old
system remains reachable exactly as before if
`VITE_SYSTEM_STATUS_CONTROL_ENABLED=true` is ever set — `LocalPesoWiseBootstrap`
still mounts `SystemAvailabilityProvider` around `AuthProvider`, unchanged.

---

## 32. Real Cloud Integration Verification (this revision)

**No real credentials appear in this section or anywhere else in this
document.** The owner provided a real Supabase Cloud project's URL and
publishable (anon) key out-of-band. Those values live only in a local,
gitignored env file (`.env.local`) and were never written into any tracked
file. The pre-existing local-PesoWise `.env` (separate Supabase project) was
independently confirmed untouched — zero `MAINTENANCE`-prefixed variables
were added to it.

### 32.1 Cloud project identity and isolation

- A second, independent Supabase Cloud project — created by the owner
  specifically for this control plane — was confirmed to exist and to be
  reachable, via a read-only Supabase CLI identity check (`supabase projects
  list`).
- All Supabase CLI operations against this project ran from an **external,
  isolated workdir outside the repository** (a temp directory, `supabase
  init` + `supabase link` scoped to that directory only). The repository's
  own `supabase/config.toml`, `supabase/.temp/`, and `supabase/migrations/`
  were confirmed unchanged throughout (`git status --short supabase/`
  returned nothing at every checkpoint) — this repo was never `supabase
  link`-ed to the Cloud maintenance project.
- Before applying anything, the Cloud project was confirmed genuinely empty:
  `supabase migration list` returned no remote migrations and `supabase
  inspect db table-stats` reported zero tables. No unrelated business data
  was present.

### 32.2 Schema applied and verified live

- The canonical migration
  (`infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql`)
  was copied byte-for-byte (diff-confirmed) into the isolated CLI workdir
  under a timestamped filename and applied via `supabase db push`, after a
  `--dry-run` pass confirmed it was the *only* pending migration.
- Post-apply, `supabase migration list` showed local and remote in sync
  (single migration, matching timestamp/name), and `supabase inspect db
  table-stats` reported both tables present: `maintenance_status` (2 rows —
  the `preview`/`production` bootstrap rows from the migration's own seed
  insert) and `maintenance_admins` (0 rows, as expected — no admin has been
  authorized yet).

### 32.3 RLS and grants — behaviorally verified against the live project

Verified via direct PostgREST calls using the real publishable key (never
recorded in any tracked file):

| Check | Result |
|---|---|
| Anonymous `SELECT` on `maintenance_status` | **Allowed** — returns both rows |
| Anonymous `INSERT`/`UPDATE`/`DELETE` on `maintenance_status` | **Denied** (401/permission error) on every verb |
| Anonymous `SELECT` on `maintenance_admins` | **Denied** — table not enumerable by anon, matching design |

This matches the design in §8/§31.3 exactly: public read-only status,
no anonymous write path, admin roster invisible to anonymous clients. Checks
that require an authenticated non-admin, an authenticated inactive admin, or
an authenticated admin with mismatched environment authority could not be run
live yet, since **no Cloud Auth user exists in this project** (see §32.7) —
those remain covered by `infra/maintenance-cloud/SECURITY_TEST_CHECKLIST.sql`
(SQL-simulation, not yet re-run against live data) rather than a live
authenticated call.

### 32.4 Direct public read — proven via actual frontend code, not just curl

`fetchMaintenanceStatus('preview', 2500)` (the real
`src/integrations/maintenance-cloud/maintenanceStatusService.ts` function,
invoked in a running browser session against the local dev server with
`VITE_MAINTENANCE_CONTROL_ENABLED=true` and the real Cloud env values) was
called directly and returned live Cloud data matching the CLI/curl-verified
content exactly. This confirms the actual application code path reaches the
Cloud project successfully, independent of any mocking.

One tooling limitation encountered and worked around: the sandboxed browser's
network-inspection tools (`read_network_requests`,
`performance.getEntriesByType('resource')`) never surfaced the outbound
cross-origin request to the Cloud project's domain, despite the call
demonstrably succeeding. This is assessed as a sandbox/CORS-timing tooling
gap, not a code defect, and was superseded by the stronger, conclusive
evidence in §32.6 (live UI rendering of real Cloud data end-to-end).

### 32.5 Fail-open — proven against a real invalid endpoint, not only mocks

With `.env.local` temporarily pointed at a deliberately non-existent host
(and restored immediately after), a fresh dev server run confirmed:

- The application still rendered the normal homepage — no block, no crash,
  no `ErrorBoundary` trigger.
- The browser console showed only the expected DNS-resolution failure
  (`net::ERR_NAME_NOT_RESOLVED`) with no unhandled exception.

This is a real-network fail-open proof, complementary to the existing unit
tests in `maintenanceResolver.test.ts` / `maintenanceStatusService.test.ts`
which cover the same contract exhaustively but with mocked outcomes.

### 32.6 Live preview-maintenance toggle — full end-to-end proof

One authorized, narrowly-scoped live mutation test was performed, using the
CLI's privileged connection as the "trusted admin path" (deliberately not the
anon/publishable key, which correctly cannot write per §32.3):

1. A one-off migration set the **preview** row's `force_maintenance = true`
   with a test title/message. Dry-run confirmed it was the only pending
   change before applying.
2. The running app was reloaded: `CloudMaintenanceScreen` rendered the exact
   live title/message from the Cloud row.
3. Confirmed no local-Supabase auth activity occurred while blocked (no
   local-auth `localStorage` keys were created; `LocalPesoWiseBootstrap`
   never mounted).
4. "Check again" was clicked; the displayed last-checked timestamp updated,
   confirming a fresh Cloud read rather than a cached result.
5. `/admin/maintenance/login` was loaded while the block was active and
   rendered correctly — confirming the admin route bypasses the block by
   design (`MaintenanceAdminApplication` never routes through
   `MaintenanceBootstrap`).
6. A paired restore migration set the preview row back to
   `force_maintenance = false` with `title`/`message`/`starts_at`/`ends_at`
   all `null`. A read-back via curl confirmed the exact restored state and a
   fresh audit-trigger-stamped `updated_at`.
7. The app was reloaded once more and rendered the normal homepage again.

**Production's `updated_at` was confirmed unchanged (byte-for-byte identical
before/after) throughout every step above** — the production row was never
written to by any part of this test.

### 32.7 Blocked on owner action — not fabricated, not skipped

The following remain genuinely incomplete because they require an action
only the project owner can take (creating a real person's login credentials
is explicitly outside what this session will invent):

- **No Cloud Auth user exists yet** in the maintenance Cloud project. Until
  the owner creates one (Supabase Dashboard → Authentication → Users) and
  shares the resulting user UUID, the following cannot be completed:
  - Authorizing that UUID in `maintenance_admins`
    (`can_manage_preview`/`can_manage_production`)
  - A live `/admin/maintenance/login` → dashboard test
  - A live Cloud-auth-vs-local-auth storage isolation test
  - The subset of §32.3's RLS matrix that requires an authenticated
    non-admin/inactive-admin/wrong-environment-admin session
- **Public self-service sign-up status on the Cloud project** has not been
  confirmed disabled via the Dashboard (Authentication → Providers → Email →
  "Allow new users to sign up") — this is a one-click owner check, not
  something the CLI/SQL path used in this session can read or set safely.
- **Vercel Preview environment variables** have not been configured. Doing
  so requires Vercel dashboard/CLI access this session does not have, and
  the instruction for this pass was to configure it only if branch-specific
  scoping could be proven safe first — it could not be proven from this
  session, so it was left untouched.
- **Production remains fully untouched**: no SQL was ever run against the
  `production` row except read-only verification queries, no Production
  Vercel env vars were set, and `VITE_MAINTENANCE_ENV` in every local test
  this session ran was `preview`.

### 32.8 Gates (this revision)

- `tsc --noEmit` — clean.
- `npm run migrations:check` — clean, 186 files unchanged from baseline.
- `npm run security:secrets` — clean.
- `git diff --check` — clean.
- Full `vitest run` — 173/174 files, 3225/3227 tests passing. The 2 failures
  are the pre-existing `repair6546Level2RoutingAndAudit.test.ts` CRLF
  line-ending fragility, unrelated to this branch's changes (confirmed via
  `git diff origin/main...HEAD --name-only`, which does not touch that test
  file or its underlying migration) and already present on `main`.
- `npm run lint` (targeted at every file this session touched:
  `src/maintenance/`, `src/integrations/maintenance-cloud/`,
  `src/pages/maintenance-admin/`, `src/main.tsx`) — **0 errors**, 3
  pre-existing-style `react-refresh`/`exhaustive-deps` warnings, no new
  problems. The full-repo lint run's ~373 errors are entirely in files this
  branch never touches (e.g. `UserManagement.tsx`, `ExpenseService.ts`,
  Supabase Edge Functions) and are pre-existing baseline noise.

### 31.5 Phases completed vs. not yet completed (§24)

| Phase | Status |
|---|---|
| 0 — Current code audit | **Done** (§3) |
| 1 — Create Cloud Supabase project | **Done** — owner created the project |
| 2 — Apply Cloud-only schema/RLS | **Done** — applied and behaviorally verified live (§32) |
| 3 — Maintenance Cloud client | **Done** |
| 4 — Direct read service | **Done** |
| 5 — Fail-open bootstrap | **Done**, proven against a real DNS failure (§32.5) |
| 6 — Move maintenance gate above local Auth | **Done** (§5.0/§31.1) |
| 7 — Cloud maintenance login | **Done** (foundation). Owner admin account created and authorized in `maintenance_admins` (§33.1) — actual browser sign-in still needs the owner to type their password (never done by this session, see §33.7) |
| 8 — Maintenance dashboard | **Done** — V1 write controls (force/schedule/save/cancel) implemented, danger-confirmed, read-back verified (§33.4) |
| 9 — Preview environment integration | **Done** — real Cloud project, Vercel Preview env scoped to this branch (§33.6) |
| 10 — Security/RLS tests | **Run live** against the real project with the real owner admin UUID — full A–H matrix passed (§33.2) |
| 11 — Local-server-offline simulation | **Done** — proven live for the admin login route and for the public maintenance screen (§32.6/§33.3) |
| 12 — Production configuration | **Not done**, explicitly out of scope for this pass |
| 13 — Retire old Vercel API / Edge Config path | **Not done**, explicitly deferred until the new path passes full owner QA |
| 14 — Documentation / runbook finalization | This revision (§33) covers the admin-authorization and dashboard build; the operational runbook (§16) still needs a final pass once owner login is verified |

---

## 33. Owner Admin Authorization, Dashboard V1, and Live Verification (this revision)

**No real credentials, UUIDs, or Cloud identifiers appear in this section.**
Every check below was run against the real Cloud project from the isolated
external CLI workdir (never `psql`/direct TCP — this sandbox's egress blocks
port 5432 for a direct client, but the Supabase CLI's own connection path
works; see the implementation report for the mechanism). Every read/rollback
test used `BEGIN...ROLLBACK` plus a DO-block `EXCEPTION` handler around any
grant-level denial, so no hard error aborts the migration file and nothing
tested persists.

### 33.1 Owner admin authorized

The owner-provided Cloud Auth user (confirmed to exist, email confirmed) was
authorized in `maintenance_admins` with `is_active=true`,
`can_manage_preview=true`, `can_manage_production=true`. Read back and
confirmed exactly matching.

### 33.2 Full RLS + audit-trigger matrix — run live, all passed

Using the real owner UUID (never a synthetic one — no second Cloud Auth user
exists, so DENY scenarios were simulated by temporarily flipping the owner's
own `maintenance_admins` flags inside a rolled-back transaction, then
restoring via rollback, per the task's own "transaction/claims test" guidance):

| Test | Result |
|---|---|
| A — anon SELECT | ALLOW (2 rows) |
| B — anon UPDATE | DENY (grant-level permission error) |
| C — authenticated, not in `maintenance_admins` | DENY (RLS, 0 rows) |
| D — owner admin, preview UPDATE | ALLOW, `updated_by` = owner |
| E — owner admin, production UPDATE (by policy; rolled back) | ALLOW, `updated_by` = owner |
| F — inactive admin (flag flipped, rolled back) | DENY (RLS, 0 rows) |
| G — preview-only admin, production UPDATE (flag flipped, rolled back) | DENY (RLS, 0 rows) |
| H — audit trigger | `updated_by` = owner (server-derived), `updated_at` advanced; forging either column client-side → DENY (grant-level, column excluded) |

A pre/post-test read of both `maintenance_status` rows and the owner's
`maintenance_admins` row confirmed byte-identical state before and after —
every rollback worked and nothing above persisted.

### 33.3 Local-server independence — proven live, twice

1. `.env`'s `VITE_SUPABASE_URL` was pointed at a nonexistent host and the dev
   server restarted. `/admin/maintenance/login` rendered correctly; zero
   network requests were recorded toward the broken host; console showed no
   local-Supabase error at all (the local client was never invoked). `.env`
   was restored and the server restarted immediately after.
2. During the live preview-maintenance test (§33.5), the public
   `CloudMaintenanceScreen` also rendered with zero local-Supabase auth
   activity, consistent with the architecture (`MaintenanceAdminApplication`
   and `MaintenanceBootstrap`'s maintenance branch never mount
   `LocalPesoWiseBootstrap`).

### 33.4 Dashboard V1 — implemented and unit-tested

`src/pages/maintenance-admin/MaintenanceAdminDashboard.tsx` was rewritten
from the foundation-pass placeholder into full write controls: current
status (Normal/Scheduled/Maintenance Active, via the existing pure
`resolveMaintenanceState`), a fixed non-selectable environment badge read
from `VITE_MAINTENANCE_ENV` (destructive-styled "PRODUCTION" badge when
applicable, never a dropdown), Enable/Disable maintenance, and a
Save/Cancel schedule form (date + the existing `MaintenanceTimePicker`
component reused as-is, title, message). Every write goes straight through
`updateMaintenanceStatus()`/`getMaintenanceSupabase()` — never a Vercel
Function, Edge Config, or the local Supabase client — and only ever submits
the writable column subset (never `environment`/`updated_at`/`updated_by`).
After every write, the dashboard re-reads the row via
`readMaintenanceStatusForAdmin()` and only shows success if the read-back
matches the update's own response; a mismatch surfaces a destructive toast
instead. Danger confirmation: every state-changing action opens a
confirmation dialog; on `VITE_MAINTENANCE_ENV=production` it carries a
PRODUCTION badge, and force-enabling specifically requires typing the word
"production" before the confirm button enables (checked with an exact,
case-insensitive match). New pure module
`src/maintenance/maintenanceScheduleValidation.ts` enforces the same
both-or-neither / end-after-start rule as the DB's own window constraint.
16 new tests (8 pure validation, 8 component-level covering the redirect,
badge, normal-vs-typed confirmation, schedule-validation blocking, and the
read-back-mismatch-is-not-success guarantee).

### 33.5 Live end-to-end preview toggle, this time via automatic polling

Repeats the Phase D live toggle, but this time proves the **automatic**
recovery path (§21) rather than a manual "Check again" click: the CLI
enabled `force_maintenance` on preview with a distinct test title, the
browser was reloaded once and showed `CloudMaintenanceScreen` with the exact
title, the CLI then restored preview to its original null/false state, and —
**with no further reload, click, or navigation from this session** — a
~30-second wait was enough for the app to notice the change through its own
20-second active-maintenance poll and mount the normal homepage on its own.
A follow-up read confirmed preview was restored to the exact original
null/false state and production's `updated_at` was byte-identical to its
value before this test — production was never written to.

### 33.6 Vercel Preview environment — configured, scoped exactly to this branch

The Vercel CLI was already authenticated (owner's account) and this repo
already linked to the real `pesowise--saas` project (confirmed by its known
production domain). `vercel env ls` showed zero existing
`VITE_MAINTENANCE_*` variables before this pass. All five variables
(`VITE_MAINTENANCE_SUPABASE_URL`, `VITE_MAINTENANCE_SUPABASE_PUBLISHABLE_KEY`
— added `--sensitive`, `VITE_MAINTENANCE_ENV`,
`VITE_MAINTENANCE_CONTROL_ENABLED`, `VITE_MAINTENANCE_REQUEST_TIMEOUT_MS`)
were added scoped to **Preview + this exact git branch**
(`vercel env add <name> preview feature/cloud-maintenance-control-plane`),
piped from the local gitignored env file directly into the CLI without ever
being echoed to a log. A follow-up `vercel env ls` confirmed all five show
`Preview (feature/cloud-maintenance-control-plane)` and nothing under
Production. Production Vercel env was not touched.

### 33.7 Still blocked on owner action — not fabricated

- **No live Cloud Auth sign-in has been performed.** The owner must type
  their maintenance-admin email/password into `/admin/maintenance/login`
  themselves; this session never has and never will hold that password. Once
  signed in, the dashboard, its write controls, session-refresh behavior,
  and the local/Cloud auth-storage isolation fix (§10/§11 of the original
  task list) all still need one live pass with a real logged-in session.
- **Public self-service sign-up status** on the Cloud project has not been
  confirmed disabled — the CLI in this environment has no safe way to read
  the current hosted Auth configuration before writing to it (`supabase
  config push` would push this session's default-generated `config.toml`
  and risk silently overwriting Auth settings the owner already configured
  via the Dashboard — email templates, redirect URLs, etc. — since there is
  no `config pull` to diff against first). The manual toggle is: Supabase
  Dashboard → Authentication → General Configuration → "Allow new users to
  sign up" → OFF.
- **Production remains fully untouched**: every write in this revision
  targeted `preview` only or ran inside a rolled-back transaction; the one
  `production` UPDATE test (§33.2, item E) was itself rolled back and the
  pre/post state comparison proves it never persisted.

---

## 34. Owner-Reported Early-Unlock Bug, Trusted Lease Architecture, and Maintenance History (this revision)

### 34.1 The incident

Owner report: a scheduled maintenance window configured for ~90 minutes
correctly showed the upcoming notice, correctly activated at `starts_at` —
then, after roughly one minute, PesoWise became available again, even
though `ends_at` was nowhere close. **Treated as a release blocker.**

### 34.2 Root cause

`MaintenanceBootstrap`'s `runCheck()` called `resolveMaintenanceState(outcome,
now)` on **every** poll and unconditionally replaced the rendered
resolution with its result. `resolveMaintenanceState` maps every
non-`"success"` outcome — `timeout`, `network_error`, `http_error`, a
momentarily-paused Cloud project — to `state: "normal"` (the fail-open
contract, correct for a fresh page load). But it was also being applied,
unchanged, to a poll happening **during an already-active, already-confirmed
maintenance window**. A single transient read failure was therefore
indistinguishable from "Cloud says normal" and instantly unmounted
`CloudMaintenanceScreen` in favor of `LocalPesoWiseBootstrap`.

**Reproduced first, confirmed before any fix**: a new regression test in
`src/maintenance/__tests__/maintenanceBootstrap.test.tsx` (see git history
for the pre-fix version) drove exactly this sequence — fresh success with an
active ~90-minute window, then a `network_error` on the next poll — and
failed against the original code exactly as the owner described: the local
app mounted, the maintenance screen disappeared.

### 34.3 The fix — a trusted maintenance lease

New module `src/maintenance/maintenanceLeaseState.ts` adds a stateful layer
on top of the existing pure `resolveMaintenanceState`. Once a **fresh,
valid** Cloud success establishes a maintenance window (scheduled or
forced), that window is held in memory as a **lease** that survives
subsequent transient failures. A lease is only ever replaced or cleared by:

- another **fresh success** (a new/changed/cancelled schedule, or
  `force_maintenance` flipping), or
- its own **natural, bounded expiry** — `ends_at` for a scheduled lease, or
  a fixed failure-grace window for a forced lease (below).

**The fail-open guarantee for a fresh browser tab is unchanged**: with no
lease yet acquired — a brand-new page load, or after a lease has expired —
a failure still resolves to `"normal"`. The lease only narrows the window
during which a failure is trusted through, and that window is always
bounded.

**Explicit trade-off, replacing the earlier, overly strict "cached data may
never activate maintenance" wording**: a fresh success may establish an
in-memory lease that is authoritative only from `starts_at` through
`ends_at` (scheduled) or until grace expiry (forced). It is **not**
persisted across a brand-new browser/page bootstrap. So: a fresh browser
tab + a paused Cloud project → normal (unchanged fail-open). An
already-open browser that previously fetched a valid schedule → honors that
exact scheduled window even through transient Cloud hiccups. This is
deliberate.

### 34.4 Forced-maintenance failure grace

Forced maintenance has no natural end time, so a lease held indefinitely on
Cloud outage would defeat the "Cloud project can be paused → eventually
normal" guarantee. Every fresh success confirming `force_maintenance=true`
records `lastConfirmedAt`. `VITE_MAINTENANCE_ACTIVE_FAILURE_GRACE_MS`
(default **180000** / 3 minutes) bounds how long a forced lease survives
with no fresh confirmation before failing open. A fresh success with
`force_maintenance=false` stops it immediately, regardless of the grace
window.

### 34.5 Exact start/end timers — polling no longer determines precision

Local timers (`scheduleAt`/`nextLeaseTransitionMs` in
`maintenanceLeaseState.ts`) fire exactly at a lease's `starts_at`,
`ends_at`, or grace-expiry boundary, re-deriving the rendered state
instantly — with zero dependency on the next poll. `scheduleAt` clamps
negative delays to fire immediately and re-arms across the platform's max
signed-32-bit `setTimeout` delay so a far-future schedule is handled
correctly rather than firing early. Every outcome application
(`applyMaintenanceOutcome`) also independently re-checks expiry, so a
throttled background tab (where timers can be delayed) still self-corrects
on its next real poll.

### 34.6 Polling reduced to 120 seconds

`MAINTENANCE_POLL_INTERVAL_NORMAL_MS` and `MAINTENANCE_POLL_INTERVAL_ACTIVE_MS`
both default to **120000** (was 60000/20000), configurable via
`VITE_MAINTENANCE_POLL_INTERVAL_NORMAL_MS` /
`VITE_MAINTENANCE_POLL_INTERVAL_ACTIVE_MS`. Polling exists only to pick up
admin-made changes and refresh a lease before it would otherwise expire —
never to determine transition precision (§34.5 owns that). Manual "Check
again" / dashboard "Refresh" remain immediate; window `focus` and
`navigator online` still trigger an immediate one-off check; the
single-flight guard still prevents any overlap. Per §29/§30: background
polls never toggle the manual "checking" UI state — only an explicit user
click does, so silent polling produces no flicker, and a transient Cloud
error during an active lease never surfaces a toast, error banner, or
switch to the normal app.

### 34.7 Route case hardening

`isMaintenanceAdminPath()` now lowercases the pathname before comparison —
`/ADMIN/MAINTENANCE/LOGIN`, `/Admin/Maintenance/Login`, etc. all correctly
route to the admin app (React Router's own path matching is already
case-insensitive by default, so no change was needed inside
`MaintenanceAdminApplication`'s own `<Routes>`). Still an exact-segment
match — `/admin/maintenanceevil` and `/foo/admin/maintenance` never match,
in any case.

### 34.8 Live release-blocker proof (mandatory)

Against the real Cloud project, PREVIEW only: a short controlled window
(~1 minute out, ~5 minutes long) was created via the trusted CLI admin
path. In the actual running app (no test harness):

1. The upcoming banner appeared with the exact DD/MM/YYYY-formatted title
   and countdown.
2. **The exact-start timer fired with zero manual reload** — the
   maintenance screen appeared automatically at `starts_at`.
3. `window.fetch` was monkey-patched in the live browser to reject every
   request to the `maintenance_status` endpoint. Two consecutive manual
   "Check again" clicks under this simulated failure — **the maintenance
   screen never dropped, no toast, no error, no local app** — the owner's
   exact bug, deliberately reproduced and proven fixed live.
4. Connectivity was restored; a fresh success (carrying the same
   still-valid window) correctly did **not** cancel the lease.
5. **The exact-end timer fired with zero manual reload** — the app
   returned to the normal homepage automatically at `ends_at`.
6. Production's `updated_at` was confirmed byte-identical before and after
   this entire test.

This satisfies the mandatory release-proof requirement.

### 34.9 Maintenance history — schema, privacy, lifecycle

New Cloud-only migration
`infra/maintenance-cloud/migrations/002_add_maintenance_history.sql`
(rollback: `.../rollbacks/002_add_maintenance_history_ROLLBACK.sql`),
applied via the same isolated CLI workdir discipline as migration 001 —
dry-run confirmed as the only pending migration, a read-only pre-migration
snapshot taken first, repo root never linked.

**Schema**: `public.maintenance_history` — one row per maintenance
**occurrence** (never a per-poll dump). `kind` (`scheduled`/`forced`),
`title`/`message`, `scheduled_start_at`/`scheduled_end_at`,
`actual_started_at`/`actual_ended_at`, `cancelled_at`,
`created_at`/`created_by`, `updated_at`/`updated_by`. Constraints mirror
`maintenance_status`'s own discipline: a scheduled row always carries a
valid window, a forced row always carries `actual_started_at`. Status
(Upcoming/Active/Completed/Cancelled, or Active/Completed for forced) is
**derived at read time** (`src/maintenance/maintenanceHistoryDerivedStatus.ts`)
from these timestamps — no cron ever moves a row through states.

`maintenance_status` gained two server-managed pointer columns,
`current_schedule_history_id`/`current_force_history_id` — never in the
frontend's writable column grant, never needed by (or added to) the public
read query.

**Atomic, trigger-only writes**: `maintenance_status_history_sync()`, a
`BEFORE UPDATE` trigger on `maintenance_status`, creates/updates/closes
history rows in the **same transaction** as the status mutation that caused
them — there is no two-write client round trip to fail halfway through.
`SECURITY DEFINER` is required (no application role has a direct grant on
`maintenance_history`) and is narrowly justified: fixed empty `search_path`,
every object schema-qualified, no client-supplied parameters (OLD/NEW come
from the trigger context, already gated by `maintenance_status`'s own
column grant and RLS), only hardcoded INSERT/UPDATE statements against one
table, actor/timestamps always server-derived (`auth.uid()`/`now()`, never
taken from NEW), and `EXECUTE` is revoked from `PUBLIC`/`anon`/`authenticated`
— it can only ever run as a trigger.

**Lifecycle** (all proven live, §34.10): saving a new schedule inserts one
row; editing the same upcoming/active schedule updates that row in place
(no duplicate for a typo fix); cancelling sets `cancelled_at` and detaches
the pointer, the row stays; a schedule that simply expires needs no action
— its derived status becomes Completed on its own, and if the pointer is
still attached to an **expired** schedule when a brand new one is saved, the
trigger creates a fresh row rather than overwriting the completed one
(the exact "after expired schedule, create new schedule" requirement).
Forced maintenance mirrors this: enabling inserts a row with
`actual_started_at`; disabling sets `actual_ended_at` on the same row;
re-enabling later starts a new row.

**Privacy — RLS is authoritative**: `maintenance_admins` gained
`can_view_history boolean not null default false`, deliberately separate
from `can_manage_preview`/`can_manage_production` (an operator may manage
maintenance without ever being authorized to see its history). `anon`: zero
access (no policy at all). Ordinary authenticated Cloud users, or admins
without `can_view_history`: zero access. An active admin with
`can_view_history=true` may `SELECT` only for environments they are
separately authorized to manage. No application role has any
INSERT/UPDATE/DELETE grant. The frontend's History tab is gated identically
(`is_active && can_view_history`) but the database policy is what actually
enforces this, independent of the UI.

**Retention**: kept indefinitely for V1 — no auto-delete, no retention
cron; the table stays small by construction.

**"History starts cleanly from migration deployment"**: nothing before
002's deployment was backfilled. The real, pre-existing schedule the owner
had configured on the preview row while testing the V1 dashboard (before
history existed) has no corresponding history row — exactly as intended.

### 34.10 Live history verification (mandatory)

Run against the real Cloud project, PREVIEW only, entirely inside one
outer transaction (nested `SAVEPOINT`s for the RLS probes) that was rolled
back at the very end — proven via a byte-identical pre/post state
comparison, so nothing below persisted:

- **Lifecycle, using the real owner admin identity**: clear → save (1 row)
  → edit in place (still 1 row, fields updated) → cancel (marked
  cancelled, pointer cleared, row preserved) → new schedule after cancel
  (a genuine 2nd row, the cancelled row untouched) → enable forced (a 3rd
  row, `actual_started_at` set) → disable forced (same row gets
  `actual_ended_at`) — **3 total occurrences, exactly as expected**, every
  `created_by`/actor field correctly stamped with the real owner UUID.
- **RLS matrix**: `anon` SELECT → grant-level DENY. Admin without
  `can_view_history` → 0 visible rows (RLS). Authorized admin → all 3
  occurrences visible for `preview`. Preview-only admin (production
  authority temporarily stripped) → 0 visible `production` rows. Direct
  `INSERT` as `authenticated` → grant-level DENY.

A **separate**, real (non-rolled-back) history row exists from setting up
§34.8's live release-blocker test via the trusted CLI path — an honest,
correctly-timestamped record of that real QA activity, left in place
rather than silently deleted (§34.9's retention policy, and honesty about
what actually happened).

### 34.11 History frontend

New `src/integrations/maintenance-cloud/maintenanceHistoryService.ts` —
`readMaintenanceHistory({environment, page, pageSize, kind?, status?,
dateFrom?, dateTo?})`, paginated (default 20/page), read-only (no write
function exists — every write is trigger-only, §34.9). New pure
`maintenanceHistoryDerivedStatus.ts` (status + duration derivation) and
`maintenanceHistorySummary.ts` (summary-card metrics: total occurrences,
total downtime — cancelled occurrences never count — average duration,
scheduled/forced split, most recent occurrence; and a 6-month monthly
downtime bucketing for the chart).

`MaintenanceAdminDashboard` is now a shell rendering **Control** and
**History** tabs (History only when `is_active && can_view_history`) —
`MaintenanceControlTab.tsx` (the existing force/schedule write surface,
plus Current status / Next maintenance / Last maintenance / Last refreshed
summary cards — "Last maintenance" itself is RLS-gated automatically, not
specially hidden, so an admin without history access simply sees "—") and
`MaintenanceHistoryTab.tsx` (summary cards; a stacked scheduled-vs-forced
monthly minutes bar chart, reusing the repo's existing `recharts`
dependency rather than adding a new one; Type/Status/date-range filters
with Clear; a responsive desktop table / mobile card list with status
badges; a detail drawer showing full occurrence fields, never a raw UUID
as the primary actor label — `"You"` for the signed-in admin's own
actions, `"Maintenance admin"` otherwise). Environment stays fixed from
`VITE_MAINTENANCE_ENV` throughout — no environment selector anywhere in
the console.

### 34.12 Public screen — local illustration and DD/MM/YYYY

New `src/maintenance/MaintenanceIllustration.tsx` — an original, locally
bundled inline SVG (a small character sitting beside a laptop and a
toolbox, gently "waiting"), not a single external asset reference anywhere.
Motion (a slow float, a gentle wrench sway, an occasional blink) is scoped
inside a `@media (prefers-reduced-motion: no-preference)` block — with
reduced motion enabled the component renders fully static. `CloudMaintenanceScreen`
and `CloudUpcomingBanner` were rewritten around it: a time card (Started /
Expected back / Duration), a live "Expected back in Xh Ym" countdown for
scheduled windows (display-only — the countdown never determines the
actual transition, §34.5 does), `"Estimated return: not set"` for forced
maintenance with no end time, "Check again" demoted to a secondary/ghost
action, and every displayed date routed through new
`formatMaintenanceDate`/`formatMaintenanceTime`/`formatMaintenanceDateTime`
helpers in `src/lib/maintenanceDateTime.ts` — explicit DD/MM/YYYY
construction (not `toLocaleDateString`/browser-locale-dependent), e.g.
`"15/08/2026 • 5:30 PM IST"`. DB storage is unchanged (UTC `timestamptz`);
only display formatting changed. Verified live in §34.8.

### 34.13 Tests

166 maintenance-suite tests pass across 15 files, including: the owner-bug
regression (fails pre-fix, passes post-fix); the full lease A–I matrix from
`maintenanceLeaseState.test.ts` (initial fail-open, scheduled/forced
transient-failure survival, exact expiry, fresh cancellation, forced
3-minute grace, precedence, malformed-window rejection); `nextLeaseTransitionMs`
directly (including the exact past-vs-future boundary bug that caused an
early busy-loop during development, fixed before merge); component-level
120s-polling, exact-start-timer, exact-end-timer, and silent-polling tests;
route case-hardening (positive and negative); DD/MM/YYYY formatter tests
(01/01, 09/08, 31/12, and edge cases); history derived-status and duration
tests; history summary/monthly-bucketing tests; the history service's
pagination/filter contract; and the dashboard's Control/History tab-gating
(both directions, plus the defensive inactive-admin case).

---

*This document is a living artifact. Update it as decisions in §27 are made and as implementation phases in §24 land — do not let it drift from reality the way the audit in §3 found the old system's own documentation had.*
