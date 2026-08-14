# Preview console triage — `get_backend_health` 404 and Vercel preview CSP noise

**Doc ID:** DOC-088  
**Status:** migration APPLIED and verified live 2026-08-08; code on `dev` only, not merged to `main`  
**Last updated:** 2026-08-08 (rev 1.1)  
**Owner / area:** Dashboard diagnostics, Supabase RPC, CSP / Vercel preview  

---

## 1) Summary

Triage of the browser console on the `dev` preview deployment
(`pesowise-saas-git-dev-…vercel.app`). The app itself worked; the console did not.

Exactly **one** entry was a real, recurring repository defect: `get_backend_health`
is called every 60 seconds by the Dashboard and **no migration in this repository
has ever created it**, so it answers 404 forever. That is fixed here with the
missing migration.

Everything else was Vercel preview infrastructure, browser-extension noise, or
one-time self-healing auth recovery. Those are documented as **deliberately not
fixed**, with the reasoning — particularly the two CSP violations, where the
"obvious" fix would weaken Production security for a cosmetic gain on preview.

---

## 2) Triage table

| # | Console entry | Source | Verdict |
|---|---|---|---|
| 1 | `vercel.live/_next-live/feedback/feedback.js` blocked by `script-src` | Vercel Toolbar, injected into preview deployments only | **Not fixed — must not fix in CSP.** See §3 |
| 2 | `vercel.com/sso-api?url=…site.webmanifest` blocked by `manifest-src 'self'` | Vercel Deployment Protection wrapping the manifest on a protected preview | **Not fixed — must not fix in CSP.** See §3 |
| 3 | `Unchecked runtime.lastError: The message port closed…` | A browser extension, not this app | Not actionable |
| 4 | `[Intervention] Images loaded lazily…` | Edge informational notice about native lazy loading | Not an error |
| 5 | `auth/v1/token?grant_type=refresh_token` → 400, `AuthApiError: Invalid Refresh Token` | A stale refresh token in `localStorage` from an earlier session | **Already handled** — see §4 |
| 6 | `auth/v1/token?grant_type=password` → 400 | One failed sign-in attempt (bad credentials) | Expected |
| 7 | `WebSocket is closed before the connection is established` | Realtime channel torn down mid-handshake when the signed-in user changed | Benign — see §5 |
| 8 | `rest/v1/rpc/get_backend_health` → **404** | **This repository calls an RPC it never creates** | **FIXED** — see §6 |

---

## 3) Why the two CSP violations were not "fixed"

Both are Vercel preview infrastructure, and neither appears on the production
host:

* `vercel.live/_next-live/feedback/feedback.js` is the **Vercel Toolbar** comment/feedback widget, injected only into preview deployments.
* `vercel.com/sso-api?...` is **Deployment Protection** intercepting the manifest request because the preview sits behind Vercel SSO.

`vercel.json` serves **one** CSP header for every environment — its `headers`
block has no environment condition. So adding `https://vercel.live` to
`script-src`, or widening `manifest-src`, would permit a third-party script host
and a third-party manifest origin **on `pesowise.unimisk.com`**, permanently, to
silence a message that only ever appears on preview. That is a real security
regression traded for a cosmetic one.

Both messages also show up twice each — once as report-only, once enforced —
because the file ships both `Content-Security-Policy` and
`Content-Security-Policy-Report-Only` with the same value. That duplication is
intentional (the report-only copy feeds violation reporting) and is not a bug.

**If the noise is genuinely unwanted**, fix it at the platform, not in the CSP:

1. Vercel → Project → Settings → **Toolbar** → disable for preview deployments; or
2. Vercel → Project → Settings → **Deployment Protection** → relax for this preview.

Neither touches the repository, and neither affects Production security.

---

## 4) The refresh-token 400

A stale `sb-…-auth-token` from a previous session is present at load, supabase-js
tries to refresh it automatically, and the server correctly rejects it.

This is already handled and self-healing:

* `src/lib/authSession.ts` → `recoverFromInvalidAuthSession()` signs out locally, clears auth storage and emits `SESSION_EXPIRED_EVENT` — and deliberately ignores transient network errors so a flaky connection never signs out a valid user.
* `src/integrations/supabase/client.ts` clears leftover `sb-*-auth-token` keys on `TOKEN_REFRESHED` with no session.

The 400 line itself is logged by the **browser's network stack**, before any
application code sees the response. It cannot be suppressed from JavaScript
without not making the request — and the request is what discovers the token is
dead. It appears once per stale session and then stops. **No change made.**

---

## 5) The WebSocket warning

The log sequence shows the realtime channel being set up for user `2b229181…`,
cleaned up, then set up for `4759e984…` — a sign-out/sign-in, i.e. the effect
behaving correctly. Closing a socket that is still mid-handshake produces this
warning in Chromium; it is a lifecycle artifact, not a leak. The subscription is
torn down properly by `supabase.removeChannel`. **No change made.**

---

## 6) The real defect — `get_backend_health` 404

**Migration:** `20260808130000_get_backend_health_rpc.sql`

`useDashboardBackendHealth` calls `supabase.rpc("get_backend_health")` on
Dashboard mount and every 60 seconds while the tab is visible. A repo-wide search
finds **no migration that creates it**. DOC-071, which introduced the health chip,
recorded:

> "No SQL, no migrations… The `get_backend_health` RPC is called via
> `supabase.rpc()` and must exist in the production database (it does; it was
> already present before this fix)."

Production disproves that: `/rest/v1/rpc/get_backend_health` returns **404**. So
the chip has been reading "Unavailable" while the backend was healthy — a
diagnostic that lies is worse than no diagnostic — and every dashboard session
has been firing a failed request a minute since DOC-071 shipped.

The new migration creates the function with the shape
`src/lib/backendHealth.ts` already parses:

```
status              'healthy' | 'degraded'
message             text
database_reachable  boolean   -- true by construction: the function ran
auth_reachable      boolean
storage_reachable   boolean
checked_at          timestamptz
```

Design notes:

* `SECURITY DEFINER`, `STABLE`, `SET search_path = public`.
* Reachability is probed with `PERFORM 1 FROM auth.users LIMIT 1` and the same against `storage.objects`. `PERFORM` **discards the result set**, so no user record or object key can reach the caller — only a boolean.
* Each probe is wrapped in its own `EXCEPTION WHEN OTHERS` block, so an unreachable subsystem downgrades the report to `degraded` instead of failing the whole call.
* `REVOKE ALL` from `PUBLIC` and `anon`; `GRANT EXECUTE` to `authenticated` only. The chip lives behind a login.
* `DROP FUNCTION IF EXISTS` precedes `CREATE`, because an earlier definition with a different return type would make `CREATE OR REPLACE` fail outright. The Dashboard chip is the only caller, so dropping is safe.
* Reads nothing, writes nothing, and — as DOC-071 required — never activates maintenance, blocks a route, signs anyone out or writes Edge Config.

### Latency semantics

Response time is measured **client-side** in `useDashboardBackendHealth`
(`performance.now()` around the call), and `backendHealth.ts` marks anything over
2000 ms as `degraded`. The RPC deliberately does not self-report timing — a
server measuring its own latency cannot see the network path the user is on.

---

## 7) Tests

`src/lib/__tests__/backendHealthRpcDefined.test.ts` — 15 assertions:

* a migration in the repo defines `get_backend_health`, and it is this one;
* the created name matches the string the hook actually calls (the exact mismatch class that caused this bug);
* SECURITY DEFINER + pinned `search_path`, STABLE, zero arguments;
* REVOKE PUBLIC/anon, GRANT authenticated only, anon never granted;
* probes use `PERFORM … LIMIT 1` rather than a bare `SELECT`, and no `email` appears;
* the migration mutates nothing and drops only the function it recreates;
* every field it returns is a field the client normalizer reads, and its status values are ones the normalizer understands.

The second assertion is the important one: it fails if the hook's RPC name and
the migration ever drift apart again.

---

## 8) Rollout

**COMPLETE — applied 2026-08-08.**

| # | Step | Status |
|---|---|---|
| 1 | Run `20260808130000_get_backend_health_rpc.sql` | ✅ done |
| 2 | `NOTIFY pgrst, 'reload schema';` | ✅ done |
| 3 | Verify grants (`authenticated` yes, `anon` no) | ✅ done |
| 4 | Reload the Dashboard and confirm the chip reads **Healthy** | ⬜ outstanding (needs a browser session) |

The owner's first attempt to run this died mid-request when Supabase Studio
returned 502/504 — see §11. Nothing was left half-applied; the retry succeeded.

Live verification (read-only):

```sql
SELECT public.get_backend_health();
```

returned:

```json
{
  "status": "healthy",
  "message": "All systems operational",
  "checked_at": "2026-08-08T16:19:54.8433+00:00",
  "auth_reachable": true,
  "storage_reachable": true,
  "database_reachable": true
}
```

Both reachability probes resolved `true`, so `auth.users` and `storage.objects`
do exist under those names on this self-hosted instance — the fallback concern
recorded in §10 did not materialise.

## 9) Rollback

```sql
DROP FUNCTION IF EXISTS public.get_backend_health();
```

The Dashboard returns to its current behaviour — chip reads "Unavailable", 404s
resume. Nothing else depends on the function.

---

## 10) Known limitation — RESOLVED

The tests were written as static assertions over the migration SQL because no
Docker or reachable Supabase existed in the authoring environment. That gap is
now closed: the function was executed live on 2026-08-08 and returned `healthy`
with all three reachability flags `true` (§8). The recorded worry — that
`auth.users` or `storage.objects` might not exist under those names and would
silently degrade the chip — did not occur.

What the tests still cannot prove is the *grant* boundary at runtime: they assert
the REVOKE/GRANT statements are present in the migration, and
`has_function_privilege` confirmed the resulting privileges, but no request has
been made as `anon` to observe the refusal end to end. Low risk, since the
privilege check is authoritative.

---

## 11) Follow-up — Supabase Studio 502/504 while applying the migration

Applying §8 surfaced a second, unrelated console: Supabase Studio's own, on
`/project/default/sql/…`. It is recorded here because the diagnosis matters for
anyone who sees it again.

**Symptoms.** `/api/platform/pg-meta/default/query?key=table-columns` → 504,
`key=database-functions` → 504 then 502, `key=` → 502, followed by two
`TypeError: Cannot read properties of undefined (reading 'includes')` crashes in
Studio's bundle. Alongside them: `/favicon/manifest.json` 401,
`/api/platform/notifications` 404 ×4, a Monaco `aria-hidden` warning, and
`favicon.ico` 404.

**Not a weak network.** `502` and `504` are statuses the *server* produced — the
request reached the host and a reverse proxy failed to get a usable answer from
an upstream. A poor signal yields `ERR_INTERNET_DISCONNECTED`,
`ERR_NETWORK_CHANGED` or a stalled request with no status at all. The chain here
is Studio → its own `/api/platform/*` Next.js routes → the **pg-meta** service →
Postgres; the break was above the database.

**The database was healthy throughout.** `pg_stat_activity` during the incident
returned only three rows: two `WalSenderWaitForWAL` logical replication slots
(logflare, realtime) sitting in their normal resting state, and one realtime
query at 0.016 s. **No locks, nothing `idle in transaction`, no blocked DDL.**

An earlier hypothesis — that an uncommitted `DROP FUNCTION` was holding catalog
locks and blocking Studio's `database-functions` query — was **disproved** by
that output and is recorded as wrong rather than quietly dropped.

**Cosmetic, expected on self-hosted:** the `notifications` 404s are a
hosted-platform-only API that self-hosted has no service for; the manifest 401 is
Kong requiring auth on a path Studio requests anyway; the Monaco `aria-hidden`
warning and `favicon.ico` 404 are Studio's own. None indicate a fault.

**If it recurs**, check whether `supabase-meta` is restarting or OOM-killed
(`docker ps -a --filter name=supabase`) rather than looking at the network. DOC-086
already documented an isolate being OOM-killed at the 150 MB per-worker limit on
this same host, so memory pressure is a known pattern here.

**Mitigation for manual runs.** Paste migrations wrapped in `BEGIN; … COMMIT;`
when running them through the Studio SQL editor. A dropped request then rolls
back cleanly instead of leaving a function dropped but not recreated. The
committed migration files deliberately omit this — the Supabase CLI wraps each
migration in its own transaction and an explicit one inside the file can conflict
with that.

---

## Revision log

| Date | Rev | Change | By |
|------|-----|--------|-----|
| 2026-08-08 | 1.1 | Migration applied and verified live: `SELECT public.get_backend_health()` returns `healthy` with `database_reachable`, `auth_reachable` and `storage_reachable` all `true`; grants confirmed (`authenticated` yes, `anon` no). §8 rewritten from a plan into a completed record with the actual output, §10 marked resolved. Also recorded §11: the first run died on Supabase Studio 502/504, and `pg_stat_activity` afterwards showed no locks, no blocked queries and only two idle `WalSenderWaitForWAL` replication slots — so the failure was transient in the Studio→pg-meta layer, not the database, and nothing was left half-applied. This corrects a doc that still claimed the migration was unapplied. No code change. | Claude Code |
| 2026-08-08 | 1.0 | Triaged the `dev` preview console. Added the missing `get_backend_health` migration — called every 60s since DOC-071, never created by any migration, 404 in production. Documented why the two Vercel preview CSP violations must be fixed at the platform rather than by widening a CSP that Production shares, and why the refresh-token 400 and WebSocket warning need no change. 15 new tests. No RLS, no data mutation, nothing deployed. | Claude Code |
