# DOC-075 — Tenant PWA Launch & Auth Origin Fix

**Last updated:** 2026-07-31
**Status:** in progress (code complete on `fix/tenant-pwa-auth-origin`; awaiting Preview + clean Android install verification)
**Branch:** `fix/tenant-pwa-auth-origin` (from `origin/main` @ `2f23854`)
**SQL executed:** **No.** Diagnostics in this doc are SELECT-only and were not run.

---

## 1. Summary

An Android user opened what they believed was the PWA for `https://ml.pesowise.unimisk.com`.
The installed app opened `https://pesowise.unimisk.com/auth` instead, the form showed
email-only mode, and employee ID `5003` was rejected with:

> Sign in failed — Enter your email address (include @).

Two independent defects produced that outcome. Both are fixed here.

| # | Defect | Effect |
|---|--------|--------|
| A | `redirectToUserTenantSignIn()` fell back to the **hardcoded apex** whenever the tenant lookup did not resolve | A tenant user was silently moved to `pesowise.unimisk.com`, where `isTenantHost === false`, so employee-ID login cannot exist |
| B | The Auth page collapsed *"still loading"* and *"the feature RPC failed"* into *"employee-ID login is disabled"* | Even while staying on the ML host, a transient error made `5003` be validated as an email address |

Supporting hardening: host-specific manifest identity and cache isolation, an
install-time manifest/host check, service-worker manifest-cache removal,
one-shot session-expired recovery, and removal of a leaked env-var name from the
production login page.

---

## 2. Problem / requirement

* Fix tenant-origin PWA launch.
* Fix employee-ID login reliability on the tenant host.
* Recover stale auth sessions safely, on the same origin.
* Audit Turnstile configuration behaviour.
* Do **not** touch Review Expenses, approvals, once-per-batch, maintenance/Edge Config,
  balances, or the upload/storage flow.

---

## 3. Root cause

### 3.1 Apex vs tenant origin (defect A)

`src/lib/tenantRedirect.ts` before the fix:

```ts
const target = subdomain?.toLowerCase() ?? null;
if (target && target === current) subdomain = null;   // ← already correct host → null
const baseUrl = buildTenantAuthUrl(subdomain);        // ← null ⇒ https://<apex>/auth
window.location.replace(`${baseUrl}?from_wrong_tenant=1`);
```

`buildTenantAuthUrl(null)` returns `https://pesowise.unimisk.com/auth`. So the browser
left the tenant origin whenever `subdomain` was `null`, and `subdomain` was `null` in
three ordinary situations:

1. `get_tenant_sign_in_subdomain_for_{email,user}` returned an error — the helper
   logs and returns `null`. The caller has just signed the user out, so the RPC
   runs as `anon` and can legitimately fail.
2. The RPC returned no subdomain for that account.
3. The user was **already on the correct tenant** (`target === current`) — the code
   deliberately nulled the subdomain, which then resolved to the apex.

The callers make this easy to hit. `verifyTenantSessionForUser()` returns
`allowed: false` not only for a genuine wrong-tenant session but also when
`get_organization_by_subdomain` fails, or the `profiles` / `organization_memberships`
query errors. `ProtectedRoute` and the Auth page both feed that result into
`rejectWrongTenantSession()` → `redirectToUserTenantSignIn()` → apex.

Once on the apex the second half follows automatically: `isTenantHost === false`
→ `resolveAuthEmail()` throws `auth:enterEmailWithAt` for any identifier without `@`.

### 3.2 Employee-ID eligibility (defect B)

`src/contexts/AuthContext.tsx` before the fix:

```ts
const { data, error } = await supabase.rpc("get_organization_feature_enabled", { ... });
if (error) { setTenantEmployeeIdLoginEnabled(false); return; }   // ← error ⇒ "disabled"
```

and `src/pages/Auth.tsx`:

```ts
const useEmployeeIdLabel = isTenantHost && tenantEmployeeIdLoginEnabled;
...
if (!isTenantHost || !tenantEmployeeIdLoginEnabled) throw new Error(t("auth:enterEmailWithAt"));
```

`tenantEmployeeIdLoginEnabled` starts `false` and is `false` while both RPCs are in
flight. A user who submitted during that window — or after any RPC failure — got the
email-format error even on the correct ML origin. The organization lookup had the
same flaw: `if (error || !data?.length)` treated "the RPC failed" and "this subdomain
has no organization" identically.

---

## 4. Solution

### 4.1 Canonical origin utility (new)

`src/lib/appOrigin.ts`

| Export | Behaviour |
|--------|-----------|
| `getCurrentAppOrigin()` | `window.location.origin` — protocol, hostname and port preserved |
| `isRunningOnTenantOrigin()` | Tenant-label resolution against the current hostname |
| `getCurrentTenantOrigin()` | Current origin when it is a tenant, else `null` |
| `buildSameOriginPath(path)` | `new URL(normalized, currentOrigin)` |
| `normalizeInternalPath(path)` | Rejects schemes (`https:`, `javascript:`) and protocol-relative `//host`; resolves `..` without escaping the root |

`buildSameOriginPath` is not a redirect gadget: any absolute or protocol-relative
input collapses to `/` on the current origin.

### 4.2 Tenant-origin preservation policy (selected behaviour)

`redirectToUserTenantSignIn()` now navigates cross-origin **only** to a positively
resolved tenant that differs from the current host:

| Situation | Behaviour |
|-----------|-----------|
| Resolved tenant ≠ current host | Cross-origin handoff to `https://<tenant>.<base>/auth?from_wrong_tenant=1` |
| Resolved tenant = current host | **Stay on this origin**, show the wrong-organization message |
| Tenant not resolved (RPC error, anon RLS, unknown email) | **Stay on this origin**, show the wrong-organization message |

The apex is never a fallback. It is reached only when the user's own tenant is the
apex — i.e. an explicit, resolved, intentional cross-tenant handoff.

Every other auth navigation is already same-origin and stays that way:
`navigate("/dashboard")` (React Router), `<Navigate to="/auth" replace />` in
`ProtectedRoute`, and the tenant landing redirect in `TenantHostRedirect`.
There is no Supabase `redirectTo` anywhere in the app, so no OAuth/magic-link
callback can move the origin.

### 4.3 Explicit tenant resolution states

`AuthContext` now exposes two independent statuses plus a retry:

```ts
tenantResolutionStatus: "idle" | "loading" | "resolved" | "not_found" | "error"
tenantFeatureStatus:    "idle" | "loading" | "resolved" | "error"
retryTenantResolution(): void
```

`src/lib/tenantSignInMode.ts` (new, pure) derives one mode from them:

| Mode | When | Identifier label | Numeric ID | Submit |
|------|------|------------------|------------|--------|
| `apex_email` | Not a tenant host | Email | rejected | enabled |
| `loading` | Either lookup in flight | Neutral "Sign-in ID" + spinner | **not rejected** — "try again" | disabled |
| `employee_or_email` | Resolved + feature enabled | Employee ID or Email | → `get_employee_auth_email` | enabled |
| `tenant_email_only` | Resolved + feature explicitly disabled | Email | rejected | enabled |
| `not_configured` | Subdomain has no organization | Neutral | "subdomain not configured" | disabled |
| `unavailable` | Either RPC failed | Neutral | "Could not verify organization sign-in settings" + **Retry** | disabled |

An "email only" label is now impossible while loading or after a failure.

### 4.4 Employee-ID resolution hardening

`get_employee_auth_email(p_organization_id uuid, p_employee_id text) → text` was
audited, **not modified**:

* migration present: `20260515120000`, hardened `20260522150000`, `20260524120000` (VOLATILE);
* declared in `src/integrations/supabase/types.ts` with matching parameter names;
* `EXECUTE` granted to `anon`, `authenticated`, `service_role` (pre-auth calls need `anon`);
* matches on `lower(trim(employee_id))` — no numeric coercion, so **leading zeros are
  significant** and `5003` stays the string `"5003"`;
* filters `COALESCE(p.is_active, true) = true` and `organization_id = p_organization_id`,
  so inactive users and other organizations cannot resolve;
* duplicates resolve via `LIMIT 1` — diagnostic block 4 detects this.

Client change: a PostgREST `PGRST202` (function not found) now raises the
migration-required diagnostic rather than a generic invalid-ID message.

**Known operational trap:** the RPC returns `NULL` when rate-limited (8 lookups per
employee ID / 15 min, 60 per organization / 15 min), which is indistinguishable from
"not found" at the client. Repeated failed attempts while debugging will therefore
start reporting an invalid ID. Diagnostic block 8 checks for this.

### 4.5 Manifest host detection and PWA identity

`api/manifest.ts`:

| | Before | After |
|---|--------|-------|
| Host source | `host` first, `x-forwarded-host` second | `x-forwarded-host` (Vercel edge) first, `host` second |
| Comma-separated chain | not handled (`split(":")` only) | first entry taken, then port/case/`www` normalized |
| `id` | `"/auth"` for **every** tenant | `"/?tenant=ml"` — stable, tenant-specific, same-origin |
| `start_url` (tenant) | `"/auth"` | `"/auth?source=pwa&tenant=ml"` (relative) |
| `scope` | `"/"` | `"/"` (unchanged) |
| Icons | absolute against a possibly-wrong host | absolute against the **resolved requesting origin** |
| `Cache-Control` | `public, max-age=300, stale-while-revalidate=600` | `private, no-cache, no-store, must-revalidate` |
| `Vary` | absent | `Host, X-Forwarded-Host` |
| Tenant marker | none | `X-PesoWise-Manifest-Tenant: ml` \| `apex` |

`vercel.json` carries the same `Cache-Control` + `Vary` for `/api/manifest` **and**
`/site.webmanifest`. The stricter caching is deliberate and temporary: revisit only
once host-aware CDN cache isolation is proven end to end.

Browsers isolate PWAs by origin, so the apex and ML installs were already separate
apps. The tenant-specific `id` removes any remaining chance of identity collision or
reuse, and the marker header makes a wrong-host response detectable at install time.

`index.html` keeps `<link rel="manifest" id="pesowise-manifest-link" href="/site.webmanifest">`.
Audit result: nothing rewrites it to an absolute apex URL — `src/lib/pwa.ts`
`applyManifestLink()` sets the relative `/site.webmanifest` in production and a
blob URL only in dev.

### 4.6 Install flow

`src/lib/manifestVerification.ts` (new) fetches `/site.webmanifest` from the current
origin with `cache: "no-store"` and refuses the install prompt unless:

1. `X-PesoWise-Manifest-Tenant` equals the marker expected for this hostname,
2. `start_url` resolves same-origin,
3. `scope` resolves same-origin.

On mismatch, `usePwaInstallFlow` shows a safe diagnostic and calls `refreshManifestLink()`
(cache-busted, same-origin). It does **not** unregister workers or delete caches —
no unrelated PWA data is touched. On a tenant host with a resolved organization the
button reads **Install &lt;Organization Name&gt;**, not "PesoWise".

### 4.7 Old-install cleanup — important

A service worker cannot change another origin's installed app, and Chrome keys PWAs
by origin. **An apex-installed PWA cannot become an ML PWA through a deploy.** If the
user's launcher icon opens `pesowise.unimisk.com`, it was installed from the apex and
must be uninstalled and reinstalled from the ML host (§9).

### 4.8 Service worker

`public/sw.js`, cache version `pesowise-v12` → `pesowise-v13`:

* the manifest is **no longer precached and no longer intercepted** — the branch
  returns without `respondWith()`, so the browser always fetches it from the network
  (a stored copy could give this origin another host's app identity);
* the apex-branded `FALLBACK_MANIFEST` (`name: "PesoWise"`, `start_url: "/"`) is deleted;
* `activate` deletes only `pesowise-`-prefixed caches, not every cache on the origin;
* unchanged and deliberately preserved: no `skipWaiting()`, no `clients.claim()`, no
  `controllerchange` reload — the earlier PWA reload-loop stability work stands;
* no absolute URL, no `Response.redirect`, no auth/session code in the worker;
* cross-origin requests are ignored (`reqUrl.origin !== self.location.origin`).

### 4.9 Session recovery

`recoverFromInvalidAuthSession()` now has a one-shot latch and dispatches
`pesowise:session-expired` once. `SessionExpiredNotice` (new, mounted in `App`) shows a
single toast: *"Your session expired. Please sign in again."*

* Only `/refresh token/i` errors clear state; `Failed to fetch` / network errors are
  explicitly excluded and never clear a valid session.
* The recovery **does not navigate**. Clearing auth state makes `ProtectedRoute`
  render `<Navigate to="/auth" replace />` — same origin, so a tenant user lands on
  `https://ml.pesowise.unimisk.com/auth`.
* Repeated Supabase failures produce one `signOut`, one event, one toast and one
  GlitchTip trail instead of a storm.

### 4.10 Turnstile behaviour

* The production login page no longer renders *"Security check loads when
  VITE_TURNSTILE_SITE_KEY is configured."* The `auth:captchaEnvHint` key is removed
  from EN/HI/GU, and the `console.warn` naming the variable is deleted (it was
  forwarded to GlitchTip by `captureConsoleIntegration`).
* No environment-variable name is shown to users anywhere on the page.
* When Turnstile is not configured the widget renders nothing and sign-in is **not**
  blocked — employee login proceeds normally.
* When it *is* configured, a token is still required before submit.
* If Supabase itself demands a CAPTCHA while the site key is missing, the existing
  `auth:captchaNotConfigured` message is shown.
* No secret key exists in browser code (only the public `VITE_TURNSTILE_SITE_KEY`).
* Allowed hostnames must include the wildcard — see §7.

---

## 5. Key files touched

| File | Change |
|------|--------|
| `src/lib/appOrigin.ts` | **new** — canonical same-origin helpers |
| `src/lib/tenantSignInMode.ts` | **new** — pure sign-in mode derivation |
| `src/lib/manifestVerification.ts` | **new** — install-time manifest/host check |
| `src/components/SessionExpiredNotice.tsx` | **new** — single session-expired toast |
| `src/lib/tenantRedirect.ts` | no apex fallback; same-origin stay-here path |
| `src/lib/tenantAccess.ts` | removed apex hostname from the wrong-org message |
| `src/contexts/AuthContext.tsx` | resolution/feature statuses; error ≠ disabled; retry |
| `src/contexts/auth-context.ts` | status types + context fields |
| `src/pages/Auth.tsx` | mode-driven label/placeholder/submit; loading + Retry UI; `PGRST202` diagnostic; Turnstile hint removed |
| `src/hooks/usePwaInstallFlow.ts` | manifest verification gate; tenant install branding |
| `src/App.tsx` | mounts `SessionExpiredNotice` |
| `src/test/setup.ts` | new auth-context fields in the shared mock |
| `api/manifest.ts` | forwarded-host precedence, tenant `id`/`start_url`, `Vary`, no-store, tenant marker |
| `vercel.json` | manifest cache policy + `Vary` for `/api/manifest` and `/site.webmanifest` |
| `public/sw.js` | v13; manifest never cached; scoped cache purge; apex fallback manifest removed |
| `src/locales/{en,hi,gu}/auth.json` | `identifierGeneric`, `identifierGenericPlaceholder`, `checkingOrgSettings`, `orgSettingsUnavailable`, `retry`, `sessionExpired`; removed `captchaEnvHint` |
| `src/locales/{en,hi,gu}/common.json` | `pwa.installTitleOrg`, `pwa.installBlockedTitle`, `pwa.installBlockedDescription` |
| `scripts/diagnose-tenant-employee-login.sql` | **new** — SELECT-only diagnostics |

---

## 6. Database / migrations

**No migration is added and no SQL was executed.**

`scripts/diagnose-tenant-employee-login.sql` is read-only and covers, in order:

1. `ml` subdomain → organization id (and uniqueness)
2. `employee_id_login` feature value — distinguishing *missing row* from *explicitly false*
3. employee ID `5003` membership, active flag, auth email presence, stored length
4. duplicate employee IDs inside the organization
5. cross-organization occurrences of the same employee ID
6. existence + signature + volatility of all six tenant/auth RPCs
7. `anon` / `authenticated` EXECUTE privileges on the three pre-auth RPCs
8. current rate-limiter state for the organization and for `5003`
9. *(commented out)* end-to-end RPC call — **VOLATILE, writes a rate-limit row**;
   returns a boolean rather than the synthetic email so the address stays out of
   result grids, logs and tickets

---

## 7. Manual configuration checklist (nothing changed automatically)

### Vercel — Domains
- [ ] `pesowise.unimisk.com`
- [ ] `*.pesowise.unimisk.com`
- [ ] `ml.pesowise.unimisk.com` — only if explicitly configured separately
- [ ] All of the above point to the **same current Production deployment**

### Vercel — Environment
- [ ] `VITE_APP_BASE_DOMAIN=pesowise.unimisk.com` — **must stay the apex**; setting it
      to the ML hostname globally would break tenant detection for every other org

### Vercel — Redirects (already correct in `vercel.json`, verify no dashboard override)
- [ ] Only `www.pesowise.unimisk.com` and `peso-patidar.vercel.app` redirect to the apex
- [ ] `ml.pesowise.unimisk.com` is **not** redirected

### Supabase — Auth URL configuration
- [ ] Site URL: `https://pesowise.unimisk.com`
- [ ] Additional Redirect URLs:
      `https://pesowise.unimisk.com/**`,
      `https://*.pesowise.unimisk.com/**`,
      `https://ml.pesowise.unimisk.com/**`
- [ ] Confirm this Supabase version actually honours wildcards; if not, add the ML URL explicitly

### Cloudflare Turnstile — allowed hostnames
- [ ] `pesowise.unimisk.com`
- [ ] `*.pesowise.unimisk.com`
- [ ] `ml.pesowise.unimisk.com`

### Storage / CORS allowed origins (where configured)
- [ ] `https://pesowise.unimisk.com`
- [ ] `https://ml.pesowise.unimisk.com`

No keys are recorded in this document.

---

## 8. Preview verification

Deploy a **Preview** only. Do not touch Production.

### Browser mode
1. Open the ML tenant origin directly.
2. Confirm the address bar still shows the ML host (no apex bounce).
3. Open `/site.webmanifest`.
4. Confirm response header `X-PesoWise-Manifest-Tenant: ml`.
5. Confirm `name` uses the ML organization branding.
6. Confirm `start_url` is the relative `/auth?source=pwa&tenant=ml` and `scope` is `/`.
7. Confirm `id` is `/?tenant=ml`.
8. Enter employee ID `5003`.
9. Confirm it is **not** rejected as an email.
10. Confirm the network tab shows `get_employee_auth_email` being called.
11. Confirm the dashboard loads and the origin is still ML.

### Tenant-resolution states
12. Block `get_organization_feature_enabled` in devtools → confirm **Retry** appears and the
    label does **not** say "Email".
13. Click Retry with the block removed → confirm the label becomes "Employee ID or Email".

### PWA clean install
1. Uninstall the existing PesoWise PWA from the device.
2. Clear site data **separately** for `pesowise.unimisk.com` and `ml.pesowise.unimisk.com`.
3. Confirm no old installed app remains in the launcher.
4. Visit the ML host in Chrome.
5. Confirm the install prompt shows the ML organization name.
6. Install, close Chrome, launch the installed app.
7. Confirm the visible origin is `ml.pesowise.unimisk.com`.
8. Confirm the start route is `/auth`.
9. Enter `5003` and confirm login succeeds.
10. Close and relaunch — confirm it stays on ML.

### Existing-install upgrade
1. Deploy the repaired Preview over an existing install.
2. Let the service worker update naturally; relaunch.
3. Confirm no reload loop.
4. Confirm a wrong-origin install is identified clearly by the install-blocked diagnostic.
5. Do **not** claim an apex-installed PWA has become an ML PWA — it has not (§4.7).

### Invalid session
1. Corrupt/remove the refresh token in a test session.
2. Reload the ML host.
3. Confirm exactly one session-expired message.
4. Confirm ML `/auth` opens on the ML origin.
5. Confirm no apex redirect and no error loop.

---

## 9. Android uninstall / reinstall (required for the reporting user)

1. Long-press the PesoWise icon → **App info** → **Uninstall** (or drag to Uninstall).
2. Chrome → ⋮ → **Settings** → **Site settings** → **All sites**.
3. Open `pesowise.unimisk.com` → **Delete data**.
4. Open `ml.pesowise.unimisk.com` → **Delete data**.
5. Chrome → ⋮ → **History** → **Delete browsing data** → Cached images and files.
6. Fully close Chrome (swap out of recents).
7. Open Chrome and go to `https://ml.pesowise.unimisk.com`.
8. Confirm the address bar reads `ml.pesowise.unimisk.com`.
9. ⋮ → **Add to Home screen** / **Install app**.
10. Confirm the prompt shows the **ML organization name**, not "PesoWise".
11. Install, close Chrome, launch from the home screen.
12. Confirm the app header/origin shows `ml.pesowise.unimisk.com` and the route is `/auth`.
13. Sign in with employee ID `5003`.

---

## 10. Test plan

85 new tests across 6 files (1626 → **1711** total, all passing).

| File | Covers |
|------|--------|
| `src/lib/__tests__/tenantOriginResolution.test.ts` | apex vs tenant, port/case normalization, unrelated + multi-level hosts rejected, base-domain fallback, same-origin path building, external-redirect rejection |
| `src/lib/__tests__/tenantSignInMode.test.ts` | loading never shows email-only; enabled → Employee ID or Email; disabled → email-only; RPC failure → Retry, not "disabled"; `not_found` ≠ `error` |
| `src/pages/__tests__/AuthTenantSignIn.test.tsx` | `5003` accepted; `get_employee_auth_email` called with the exact string; resolved email used for sign-in; leading zeros preserved; no RPC while loading; origin preserved on success/failure; apex email login intact; no `VITE_` text rendered; missing Turnstile does not block |
| `src/lib/__tests__/manifestTenantOrigin.test.ts` | forwarded-host precedence and comma chains; tenant vs apex manifests; relative tenant `start_url`; distinct `id`; `scope: "/"`; same-origin icons; no absolute apex URL; no-store + `Vary`; ML not in the Vercel redirect list |
| `src/lib/__tests__/manifestInstallVerification.test.ts` | ML manifest accepted on ML; apex manifest rejected on ML; cross-origin `start_url`/`scope` rejected; prompt gated behind verification; tenant branding; no cache/worker deletion |
| `src/lib/__tests__/swAndSessionOriginSafety.test.ts` | SW: `/sw.js` scope `/`, no absolute URL, same-origin fallback, manifest never cached, v13, scoped purge, no reload-on-focus, no auth code. Redirect: no apex fallback. Session: cleared once, one event, network errors preserve the session, no navigation |

Regression: all 92 pre-existing test files still pass unchanged, including Review
Expenses, once-per-batch and upload-flow suites.

### Validation results

| Check | Result |
|-------|--------|
| `git diff --check` | clean |
| `npx tsc --noEmit` | pass |
| `npm run typecheck:api` | pass |
| `npm test -- --run` | **1711 passed / 98 files** |
| `npm run build` | pass |
| `npm run migrations:check` | pass (pre-existing filename warnings) |
| `npx tsx scripts/i18n-check-keys.ts` | **fails — pre-existing**, unchanged set |
| `npm run lint` | **458 problems — pre-existing**, unchanged |

Pre-existing i18n gaps (present at `2f23854`, untouched here): `hi`/`gu` `expenses.form.draft.*`,
`hi`/`gu` `nav.teamReports`, `gu` `common.pwa.androidStep1`.

---

## 11. Excluded from this change

### Storage failures — separate issue
`StorageUnknownError: Failed to fetch` and `Upload failed: Failed to fetch` were
**not** addressed. Other uploads in the same logs succeeded and
`moveTempFilesToExpense` reported `movedCount > 0, failedCount = 0`, which is the
signature of transient network/storage flakiness, not a CORS/origin fault. Code
inspection found no path where the wrong-origin redirect causes an upload to
cross-origin. Receipt handling, temp-file movement, backup behaviour and upload
semantics are unchanged. Track separately; if a failed request later proves the
tenant host is missing from an allowed-origin list, apply §7's Storage/CORS row.

### Untouched by explicit instruction
Review Expenses behaviour, approval behaviour, once-per-batch, maintenance /
Edge Config, balances. `CODEX_PROJECT_NOTES.md` remains untracked and uncommitted.

---

## 12. Rollout and rollback

**Rollout**
1. Merge `fix/tenant-pwa-auth-origin` after Preview verification (§8).
2. Apply the §7 configuration checklist manually before/with the Production deploy.
3. Instruct affected Android users to run §9 — a deploy alone cannot fix an
   apex-installed PWA.

**Rollback**
Revert the single commit. It is self-contained: no migration, no data change, no
Production configuration change. Reverting restores `pesowise-v13` → `v12`; the SW
purges only `pesowise-`-prefixed caches, so no manual cache clearing is needed.
The one user-visible regression on rollback is the return of the apex fallback
redirect and the email-only-while-loading behaviour.

---

## 13. Not yet verified

The PWA problem is **not** declared fixed. That requires, on a real device:

* a clean Android install from `ml.pesowise.unimisk.com` that launches on the ML origin, and
* employee ID `5003` reaching `get_employee_auth_email` from that installed app.

Until both are observed, this doc stays **in progress**.

---

## Revision log

| Date | Rev | Author | Notes |
|------|-----|--------|-------|
| 2026-07-31 | 1.0 | Agent | Initial — apex-fallback redirect removed (`tenantRedirect.ts`); explicit `tenantResolutionStatus`/`tenantFeatureStatus` + Retry so an RPC error is no longer reported as "feature disabled"; `appOrigin.ts`, `tenantSignInMode.ts`, `manifestVerification.ts`, `SessionExpiredNotice.tsx` added; manifest gains forwarded-host precedence, tenant-specific `id`, relative tenant `start_url`, `Vary` + no-store, `X-PesoWise-Manifest-Tenant`; SW v13 stops caching the manifest and drops the apex-branded fallback; one-shot session-expired recovery; Turnstile env-var hint removed from the login page; SELECT-only diagnostics added; 85 new tests (1711 total); **no SQL executed, no Production config changed** |
