# GlitchTip error quality, grouping and source maps

**Doc ID:** DOC-090  
**Status:** implemented; source-map upload **VERIFIED green** (§9c) and live-event behaviour **VERIFIED** in GlitchTip — meaningful titles (no minified symbols), one occurrence per crash, correct issue separation, no new `$L`-class noise (§13b). **Frame-level stack symbolication (original `src/…` file + function + line) is PENDING a final visual confirmation** — the issue *list* was reviewed, the inner stack frame was not. The temporary verification surface has been **removed** from the tree. Production/main rollout still pending.  
**Last updated:** 2026-08-10 (rev 1.5 — Firefox stale dynamic-import recovery hotfix)  
**Owner / area:** Observability, build pipeline  

---

## 1) Summary

GlitchTip was receiving events but the issue list was not usable. It contained
meaningless minified titles (`$L`, `LL`, `z$`, `hL`, `a2`, `k2`, `C2`) next to
real errors, the same failure appeared as several issues, and ordinary
validation messages such as *"Purpose / Title is required"* were filed as
application errors.

The root causes were three design choices, not a subtle bug:

1. **Console output was an error-ingestion API.** `captureConsoleIntegration({levels:["error","warn"]})` turned **every** `console.error` and `console.warn` into a first-class issue. This repository contains **229 `console.error`** and **111 `console.warn`** calls.
2. **Every destructive toast reported itself.** `use-toast` called `reportMessage()` for `variant === "destructive"` — **229 call sites**, most of them ordinary user feedback.
3. **No source maps.** `vite.config.ts` had `sourcemap: false`, so every production stack frame stayed minified.

This change makes GlitchTip answer *what failed, where, in which operation, on
which route, in which release and environment* — without leaking secrets or PII.

**No application behaviour changes.** Users see exactly the same toasts and the
same error handling; only what reaches monitoring differs.

---

## 2) Capture map — before

| Source | Console? | Toast? | reportError? | Global handler? | GlitchTip events |
|---|---|---|---|---|---|
| React render crash (ErrorBoundary) | ✅ `console.error` | — | ✅ `reportError` | — | **2** |
| Any handled failure showing a destructive toast | usually ✅ | ✅ auto-report | rarely | — | **2+** |
| Validation rejection ("Purpose / Title is required") | sometimes | ✅ auto-report | — | — | **1 (should be 0)** |
| Third-party / extension error | ✅ | — | — | ✅ | **1–2** |
| Any of 340 console.error/warn calls | ✅ | — | — | — | **1 each** |

Only **2** genuine `reportError` call sites existed in the entire codebase, so
almost everything in GlitchTip arrived through console capture or the toast hook
— neither of which knows whether something is a defect.

### After

| Source | GlitchTip events |
|---|---|
| React render crash | **1** (explicit, with component stack) |
| Handled failure with `reportError(err, ctx)` | **1**, stably grouped |
| Destructive toast alone | **0** — breadcrumb only |
| Console output | **0 issues**, retained as breadcrumbs |
| Third-party-only event | **0** |
| Uncaught exception / unhandled rejection | **1** (SDK defaults, unchanged) |

---

## 3) Where `$L`, `LL`, `z$` came from

Two mechanisms, both fixed:

1. **Console capture of minified values.** `console.error(x)` in minified third-party or app code produced an event whose title came from the console argument or the top minified frame — a symbol like `$L`.
2. **No source maps.** Even genuine exceptions surfaced with minified frames, so grouping and titles were built from mangled identifiers.

The fix is **not** a blacklist of those seven strings. `isMeaninglessTitle()`
tests the *shape*: a token of ≤4 characters, no whitespace, made only of
identifier characters, cannot describe a failure to a human. Genuinely
meaningful short tokens (`404`, `500`, `NaN`, `OOM`) are explicitly preserved.

---

## 4) Decisions

### Console capture — REMOVED

`captureConsoleIntegration` is gone. With 340 console calls it was the single
largest noise source, and a `console.warn` from a library is not a defect.
Console output still reaches events through the SDK's default
`breadcrumbsIntegration`: **context, not issues.**

### Manual default integrations — REMOVED

Verified against the installed **@sentry/react 10.58.0** source
(`getDefaultIntegrations` in `@sentry/browser`): `browserApiErrorsIntegration`
and `globalHandlersIntegration` **are already defaults**, alongside
`breadcrumbs`, `dedupe`, `linkedErrors`, `httpContext` and `inboundFilters`.

`getIntegrationsToSetup` merges defaults with user integrations and then calls
`filterDuplicates`, so the previous manual registrations did **not** double-fire
handlers — they were redundant, and they created the false impression that
removing them would disable global capture. The `integrations` option is now
omitted entirely so the defaults apply.

### Destructive toasts — NO LONGER REPORT

A toast is presentation. It cannot know whether the cause was a bug, and it has
none of the context (status, error code, RPC name) that makes an issue
actionable. Monitoring now happens in the `catch` block that has that context.

Deliberately **not** solved with a message blacklist in `use-toast`: that would
put observability policy in a UI component and would silently rot as copy
changes.

---

## 5) Classification model

Implemented in `src/lib/monitoringClassify.ts` — pure functions, no Sentry
imports, fully unit-testable.

| Class | Example | Outcome |
|---|---|---|
| **A. Unexpected application error** | `TypeError`, render crash | **Issue** |
| **B. Backend/network failure** | RPC 500, storage failure | **Issue**, with area/operation/code/route |
| **C. Expected validation** | "Purpose / Title is required" | **Breadcrumb only** |
| **D. Expected auth lifecycle** | stale refresh token the app clears | **Dropped** |
| **E. Third-party / extension noise** | extension frames, webkit bridge | **Dropped — only with no app frame** |

### The evidence rule

`window.webkit.messageHandlers` and *"Java object is gone"* are dropped **only
when the stack contains no PesoWise frame**. The identical message *with* an
application frame is kept, because then it is our bug. A test asserts both
directions — this is the difference between filtering noise and hiding defects.

Similarly, `isExpectedAuthRecovery` matches only the specific recoverable states
(`Invalid Refresh Token`, `Refresh Token Not Found`, `Auth session missing`).
`AuthApiError: Unauthorized` still reports. This is **not** "suppress all
AuthApiError".

Explicitly reported events carry `pesowise_handled` and are **never** dropped —
the caller had the context and decided it mattered.

---

## 6) Monitoring API

```ts
reportError(error, {
  area: "expenses",
  operation: "approve-expense",
  errorCode: "PGRST301",
  severity: "error",
  tags: { … },
  extra: { … },
});
```

`normalizeError()` flattens `Error`, Supabase/PostgREST objects
(`message/code/details/hint`), `AuthApiError` (`status`), string throws, `null`,
`undefined` and unknown objects — never producing `[object Object]`,
`undefined`, or a whole serialized object as the title. The original `Error`
(and its stack) is always what gets captured; normalized fields become
tags/extra. Messages are truncated at 300 characters.

`recordBreadcrumb()` exists for expected conditions worth seeing as context.

---

## 7) Grouping

```
fingerprint = [area, operation, errorCode ?? errorName]
```

Applied **only** to explicitly handled errors. Unhandled exceptions keep the
SDK's default grouping — overriding that globally would merge genuinely
distinct crashes.

The dynamic message is deliberately excluded, so *"approval failed for
transaction 00088"* and *"… 00102"* form **one** issue. Different error codes in
the same operation stay separate, so an authorization failure is never merged
with a network failure. Both properties are asserted by test.

---

## 8) Release and environment

| Constant | Source | Example |
|---|---|---|
| `__APP_RELEASE__` | `VERCEL_GIT_COMMIT_SHA` → `APP_RELEASE` → `git rev-parse HEAD` → `"unknown"` | `b67fa1e…` |
| `__APP_DEPLOY_ENV__` | `VERCEL_ENV` → mode | `production` / `preview` / `development` |

`import.meta.env.MODE` alone was insufficient: Vercel preview and Production
both build in production mode, so DEV-preview noise and real Production
incidents would land in the same environment. Both constants are non-secret by
construction.

---

## 9) Source maps

`vite.config.ts` now uses **`sourcemap: "hidden"`** — full `.map` files are
emitted for upload, but **no `//# sourceMappingURL` comment** is written into
the bundles, so browsers never request them. GlitchTip matches frames by
**debug ID** instead.

Pipeline (`scripts/glitchtip-sourcemaps.mjs`), following the current
[GlitchTip CLI documentation](https://glitchtip.com/documentation/cli/):

```
vite build
  → resolve glitchtip-cli (PATH → cache → pinned download)
  → glitchtip-cli sourcemaps inject ./dist
  → glitchtip-cli sourcemaps upload ./dist --release <sha> --org <org> --project <proj>
  → delete .map files from dist/
```

### 9a) Reproducible CLI in Vercel builds

The first credentialed Preview build **failed**:

| | |
|---|---|
| Deployment | `dpl_3ayjKGjpkCfcFZ4fGXq4jmgqoTw6` |
| Commit | `aadfd4976fb39076bb2fe4272ae29e03db935a68` (branch `dev`, Preview) |
| Result | **FAILED** |
| Cause | 86 source maps generated, then `glitchtip-cli` was **not present in the Vercel build image** — the script assumed a globally preinstalled CLI. |

The original design (`curl … install.sh | sh`) had two problems for CI: no
version pinning, and it installs to `/usr/local/bin`, whose presence on `PATH`
does not reliably survive between Vercel build phases — which is exactly how the
failure manifested (`glitchtip-cli not found on PATH`).

The build now installs the CLI itself, reproducibly:

* **Pinned version** `CLI_VERSION` (currently **v1.0.0**) with a **SHA-256 checksum** verified after download — supply-chain protection the install script does not offer. GlitchTip publishes per-version raw binaries on GitLab; the Linux x86_64 asset is a single static ELF, so there is nothing to extract.
* **Project-local install** into `node_modules/.cache/glitchtip/` (gitignored via `node_modules`), called by **absolute path** — no dependency on `PATH` surviving, and no global machine state touched.
* **Resolution precedence:** a `glitchtip-cli` already on `PATH` → a binary cached from an earlier phase → a fresh pinned download. Only `linux-x86_64` is checksum-pinned, because that is the only platform a Vercel build runs on.
* The pinned URL, checksum and ELF magic were verified end-to-end from this environment: `HTTP 200`, 14,420,352 bytes, `7f454c46`, checksum match.

Pure decision logic lives in `scripts/lib/glitchtipCli.mjs` so every branch is
unit-tested without the network.

### 9c) Verified on Vercel Preview — upload succeeds

The next credentialed Preview build (commit `5a74815`, Preview,
`pesowise-saas-8ma5k9z4b`) ran the full pipeline green. Build log:

```
[glitchtip-sourcemaps] found 86 source map(s) in dist/
[glitchtip-sourcemaps] installing glitchtip-cli v1.0.0 (pinned, checksum-verified)…
[glitchtip-sourcemaps] glitchtip-cli installed and checksum verified.
glitchtip-cli 1.0.0
[glitchtip-sourcemaps] injecting debug IDs…
Source map injection complete.  Injected: 87 file(s)
[glitchtip-sourcemaps] uploading source maps for release 5a74815a04e681ca90f29ce9a2e6db72ab6c501f…
Found 173 file(s) to upload.
…Uploaded: assets/*.js  /  assets/*.js.map …
[glitchtip-sourcemaps] upload complete.
[glitchtip-sourcemaps] removed 86 .map file(s) from dist/ — original sources are not deployed (uploaded to GlitchTip).
Build Completed  /  Deployment completed
```

Deployment state: **● Ready**.

* **Release match:** the uploaded release `5a74815…` equals the Vercel Git SHA, which is also `__APP_RELEASE__` in the browser bundle (both derive from `VERCEL_GIT_COMMIT_SHA`). One identifier throughout.
* **Environment:** `__APP_DEPLOY_ENV__` derives from `VERCEL_ENV`, which is `preview` for a Preview deployment — DEV-preview and Production stay filterable.
* **Maps not public:** the 86 `.map` files were pruned from `dist/` before Vercel packaged the output, so they are not in the deployed artifact. Independently, the preview sits behind Vercel Deployment Protection (a direct `.map` request 302-redirects to `vercel.com/sso-api`), so it is doubly inaccessible.
* **Token safety:** no `SENTRY_AUTH_TOKEN` value appears in the build log; the token flowed only through the child-process environment.

**Still pending (manual):** the controlled runtime symbolication test (§13
Test A) — triggering one real error in the running preview and confirming
GlitchTip shows the original `src/…` frame. It needs an authenticated browser
session against the SSO-protected preview, so it is out of scope for an
automated run and is left for manual execution.

### 9b) Fail-closed vs. skip

The two paths are deliberately asymmetric:

| Situation | Behaviour |
|---|---|
| **No credentials** (contributor / preview without token) | **SKIP** — no install attempted, maps pruned, **exit 0**. Builds must not depend on a Production secret. |
| **Credentials present, any step fails** (install / checksum / execute / inject / upload) | **FAIL the build (exit 1).** A configured monitored deployment must never ship silently claiming source maps are set up. Maps are pruned only *after* a successful upload. |

The auth token is passed to the CLI only through the child-process environment —
never as an argument, a URL, or a log line.

### ⚠️ The prune step is a security requirement, not tidiness

`hidden` stops the browser *requesting* maps; it does **not** stop them being
**deployed and fetchable by guessing the URL**. Since Vercel runs plain
`npm run build`, that script now always ends with the prune step — **including
when upload credentials are absent**. Not uploading is a monitoring limitation;
publishing 297 original source files would be a disclosure.

Verified on a real build: **86 maps generated, 0 `sourceMappingURL` comments, 0
`.map` files left in `dist/`, exit code 0.** Use `npm run build:keep-maps` for
local debugging.

---

## 10) Credentials — configured; upload VERIFIED green

The four **build-only** variables are now **configured in Vercel for both
Preview and Production**. The GlitchTip project was resolved from the live DSN:
org `pesowise`, project `pesowise-web`, and the browser DSN's public key matches
that project — so browser errors and uploaded source maps target the same place.

| Variable | Value |
|---|---|
| `SENTRY_URL` | `https://error-kidzo.unimisk.com/` |
| `SENTRY_ORG` | `pesowise` |
| `SENTRY_PROJECT` | `pesowise-web` |
| `SENTRY_AUTH_TOKEN` | configured (secret; never printed, never in git, never `VITE_`-prefixed) |

Reference (historical): the build-only variable definitions are —
| `SENTRY_AUTH_TOKEN` | GlitchTip API auth token |
| `SENTRY_ORG` | organization slug |
| `SENTRY_PROJECT` | project slug |

**None may be `VITE_`-prefixed** — `VITE_*` values are inlined into browser
JavaScript and would publish the token. A test asserts no
`VITE_*(AUTH|TOKEN|SECRET|KEY)` name exists in the monitoring code, vite config
or upload script. `VITE_GLITCHTIP_DSN` stays browser-side, which is correct: a
DSN is an ingestion endpoint, not a credential.

The CLI no longer needs manual installation — the build resolves and installs it
itself, pinned and checksum-verified (§9a).

**The live credentialed Preview upload has succeeded** — commit `5a74815`,
deployment `pesowise-saas-8ma5k9z4b`, ● Ready: `injecting debug IDs…` →
`uploading…` → `upload complete.` → 86 `.map` files pruned, release matching the
Vercel Git SHA, environment `preview`. Full evidence in §9c.

**The one remaining verification is a manual runtime check** (§13a): triggering a
real application error in the running Preview and confirming the resulting
GlitchTip event carries an original `src/…` frame. That requires an
authenticated browser session against the Preview, which is behind Vercel
Deployment Protection (SSO) — see §13a for why it must be done by a signed-in
human and the exact steps.

---

## 11) Privacy

`sendDefaultPii: false` retained. `Sentry.setUser({ id })` — **ID only, never
email or name**. Organization and role travel as tags. `clearMonitoringUser()`
resets identity on sign-out so one user's context cannot leak into another's
event.

`scrubObject`/`scrubUrl` redact any key matching access/refresh token,
authorization, apikey, session, password, secret, credential, cookie,
service-role, bearer, jwt or dsn — recursively, depth-limited to 6 so a cyclic
or enormous payload cannot hang the reporter. Sensitive query parameters are
stripped from URLs while the readable path is kept. Applied to `extra`,
`contexts`, `request.url`, `request.headers`, `query_string` and breadcrumbs.

---

## 12) Tests — 92 added

`monitoringClassify.test.ts` (63) · `monitoringIntegration.test.ts` (29)

Highlights, mapped to the reported symptoms:

* every `$L` / `LL` / `z$` / `hL` / `a2` / `k2` / `C2` classified meaningless, while `TypeError`, `404`, `500` are kept;
* third-party-only event dropped; **the same message with an app frame kept**;
* stale refresh token dropped; **`AuthApiError: Unauthorized` kept**;
* `Failed to fetch` with an app frame kept;
* handled events never dropped;
* dynamic transaction IDs do not fragment one issue; different codes do not merge;
* `normalizeError` never yields `[object Object]`/`undefined`;
* secrets redacted in extras, breadcrumbs, headers and URLs;
* init no-op without DSN; initializes once; no `captureConsoleIntegration`; release/environment present; `beforeSend` installed;
* `reportError` preserves the original `Error`;
* user context is ID-only and cleared on sign-out;
* source guards: `use-toast` no longer reports, ErrorBoundary reports exactly once, no manual default integrations, no `VITE_`-prefixed token, build always prunes maps.

---

## 13) Manual verification after deployment

| Test | Steps | Expected |
|---|---|---|
| **A — real error** | Trigger a controlled app error | Issue shows the real exception, **original file/function/line**, route, release, environment — not `$L` or an `index-*.js`-only stack. Remove the trigger afterwards. |
| **B — duplicate capture** | Trigger one ErrorBoundary crash | **Exactly one** issue occurrence |
| **C — validation** | Submit an expense with no title | Toast still shown; **no GlitchTip issue** |
| **D — stable grouping** | Same handled failure, two different transaction numbers | **One issue, two events** |
| **E — different failure** | A technically different controlled error | **Separate issue** |
| **F — auth recovery** | Corrupt the local refresh token, reload | App recovers; **no recurring issue** |
| **G — network** | Controlled network failure | Issue carries operation, route, release, environment, online state — not just "Failed to fetch" |

Test A is the one that proves source maps end to end. The upload half is now
verified (§9c); the runtime half is the procedure in §13a.

### 13a) Runtime symbolication — manual procedure (why it is not automated)

Tests A–G above must run in a **real, JS-executing browser signed into the
app**, and the resulting events must be read from the GlitchTip UI. On the
Preview deployment that browser also has to clear **Vercel Deployment
Protection**: a direct request to the Preview URL 302-redirects to
`vercel.com/sso-api` (confirmed — the page title is "Login – Vercel"). Passing
that gate requires a Vercel login, which an automated agent must not perform
(authenticating with someone's credentials is out of scope). So the runtime
tests are a **signed-in-human procedure**, not an automated step.

The upload they depend on is already proven, and source maps for release
`5a74815…` are uploaded, so an event from that release will symbolicate as soon
as one arrives. To run the check without shipping a deliberate crash mechanism
in the tree:

1. Open the Preview URL in a browser and complete the Vercel SSO login, then sign into PesoWise as normal.
2. **Symbolication (Test A):** in DevTools, run a call into a *bundled application module* — e.g. import a real page/service and invoke a method with a bad argument so it throws from `src/…`. (A bare `throw new Error()` typed in the console originates from a devtools VM frame and does **not** prove app-source symbolication — avoid it.) A cleaner alternative is to reproduce any genuine app error (e.g. force a failing network call the app already reports through `reportError`).
3. In GlitchTip → project `pesowise-web`, open the newest event and confirm: original `src/…` filename, real function/component, line/column, `release = 5a74815…`, `environment = preview`, a route tag — and **not** an `index-*.js`-only or `$L`/`LL` frame.
4. **Validation (Test C):** submit an expense with no title; confirm the destructive toast appears and **no** new GlitchTip issue is created.
5. **Duplicate (Test B):** trigger one ErrorBoundary crash; confirm exactly one occurrence, not a console-derived event plus an explicit one.

### 13b) Runtime verification — executed 2026-08-10 (PASS)

A temporary preview-only route `/__monitoring-test` was added (deploy
`pesowise-saas-jj1mwje7b`, release `2cfba746…`), the owner authenticated through
Vercel SSO and triggered both buttons, and the route was **removed again**
afterwards (see the closing note below). Observed in GlitchTip project
`pesowise-web`:

| Check | Evidence | Result |
|---|---|---|
| **Meaningful titles (no `$L`)** | Button 1 → `Error: GlitchTip Preview Symbolication Verification`; Button 2 → `Error: GlitchTip Preview Symbolication Verification (ErrorBoundary path)` | **PASS** — real titles, not minified symbols |
| **Duplicate capture (Test B)** | One ErrorBoundary crash produced **exactly one** issue — no console-derived event alongside the explicit `render-boundary` report | **PASS** |
| **Grouping** | The two technically-different errors formed **two separate issues**, not one merged group | **PASS** |
| **No new noise** | The only `$L` in the list is **2 days old** (historical); the new release generated none | **PASS** |
| **Source maps present for the release** | `2cfba746…` uploaded green (§9c applies identically to this build) | **PASS** |
| **ErrorBoundary UX** | The render-phase throw was caught and rendered `AppErrorFallback` ("Something went wrong") — not a blank page or uncaught crash | **PASS** |
| **Frame-level symbolication** | The issue list was reviewed (titles good, not minified); the **inner stack frame** — `src/lib/monitoringPreviewTest.ts` / `triggerGlitchTipPreviewVerificationError` / line — was **not** opened and captured | **PENDING** — final visual confirmation |

This confirms the classification, de-duplication, grouping and title-quality
behaviour on live events, not only in unit tests. Source maps are uploaded for
the matching release, so a symbolicated `src/…` frame is *expected* — but that
specific frame resolution has not yet been visually confirmed in an opened
event, so it is left **pending** rather than asserted.

**Cleanup:** the temporary route, page, trigger function and its tests were
removed after the check. `git grep` over `src/` and `scripts/` for
`GLITCHTIP_PREVIEW_VERIFICATION`, `__monitoring-test`, `MonitoringPreviewTest`
and the verification message returns **nothing** — the final `dev` tree contains
no deliberate crash mechanism.

---

## 14) Known limitations

1. **Source-map upload is live and verified on Preview** (§9c). The remaining gap is the **runtime symbolication check** (§13a), which needs a signed-in human against the SSO-protected Preview and so is not automatable here.
2. **Existing GlitchTip issues are untouched.** This affects new events only. Source maps apply to matching new events; historical payloads are not rewritten. Old noisy issues can be cleaned up separately once the new release is verified.
3. **Only 2 call sites currently use `reportError`.** The API and classification are in place, but adopting structured `reportError(err, {area, operation})` across the ~229 catch blocks that currently only toast is follow-up work. Until then those failures produce breadcrumbs rather than issues — a deliberate trade: silence is better than 229 unactionable issues, and each call site should be converted with real context.
4. `tracesSampleRate` set to `0` — this project uses GlitchTip for errors, and performance traces were being collected at 100% with no one reading them.

---

## Revision log

| Date | Rev | Change | By |
|------|-----|--------|-----|
| 2026-08-10 | 1.5 | **Firefox stale dynamic-import recovery hotfix (Production incident).** GlitchTip issue `PESOWISE-WEB-MT` — `TypeError: error loading dynamically imported module: https://pesowise.unimisk.com/assets/AdminPanel-C7JOdqoI.js` on `/admin/expenses`, Firefox 153, environment `production`, `area:react`, `operation:render-boundary`, event release `d13d846…`. Read-only HTTP proof of **version skew**: the errored chunk `AdminPanel-C7JOdqoI.js` → **404** (removed by a later deploy) while the current build's `AdminPanel-DtU40f0p.js` → **200**; a tab opened on the old release lazy-imported a deleted hashed chunk. Root cause of *why it crashed instead of self-healing*: `isStaleChunkError` recognized `Failed to fetch dynamically imported module` / `Importing a module script failed` / `Loading chunk … failed` but **NOT Firefox's exact wording** `error loading dynamically imported module`, so `lazyWithRetry` and the `ErrorBoundary` recovery both missed it and it surfaced as a React crash. **Fix (delivery/recovery only — no business/DB/SW change):** (1) new central `src/lib/chunkRecovery.ts` — `isStaleChunkError` now also matches the Firefox wording (case-insensitive) while still rejecting generic `Failed to fetch`/network/auth/validation errors; ONE shared guarded-reload primitive `recoverFromStaleChunk()` (30s sessionStorage cooldown) replaces the two duplicated copies that lived in `lazyWithRetry.ts` and `ErrorBoundary.tsx`; and `installPreloadErrorHandler()` registers Vite's browser-independent **`vite:preloadError`** event early in `main.tsx` (before any route lazy-import). On the first stale preload it `preventDefault()`s + reloads once; if the cooldown is active (already reloaded, same release still failing) it does NOT preventDefault so a genuinely broken *current* deploy stays observable. (2) `ErrorBoundary.componentDidCatch` now reloads via the shared primitive and **skips the monitoring event only while recovery is actually occurring** — a self-healing version-skew session is no longer a noisy first-class crash, but a stale error that persists past the guarded reload is still `reportError`-ed. **Deliberately unchanged (audited, §7):** `public/sw.js` (no `controllerchange`→reload, no `clients.claim()`, `/assets/` bypassed from SW cache, network-first navigation, `skipWaiting()` absent) and `pwaInstallCapture.ts`; HTML stays `no-cache,no-store,must-revalidate` while hashed `/assets/*` stay immutable. 21 new tests (matcher A–H incl. exact Firefox case, guarded single-reload/no-loop, `vite:preloadError` recover-once + stay-observable, `lazyWithRetry` reload-once/success/propagate, ErrorBoundary recover-vs-report); 2779 total (was 2758); tsc/typecheck:api/build/migrations:check/secrets clean; lint 458 unchanged. Historical issue `PESOWISE-WEB-MT` retained as evidence. | Claude Code |
| 2026-08-10 | 1.4 | Ran the manual runtime verification and recorded the result (§13b, PASS), then removed the temporary surface. A preview-only `/__monitoring-test` route (deploy `pesowise-saas-jj1mwje7b`, release `2cfba746…`) was deployed; the owner authenticated through Vercel SSO and triggered both buttons. GlitchTip showed two meaningful issues — `Error: GlitchTip Preview Symbolication Verification` and `… (ErrorBoundary path)` — **one occurrence each** (no console-derived duplicate), correctly separated into two issues, with the only `$L` being a 2-day-old historical entry (no new minified noise). Source maps for the release were uploaded green. The ErrorBoundary render-throw was caught and rendered `AppErrorFallback`. **Frame-level stack symbolication (original `src/…` file/function/line) was not opened and captured, so it is left PENDING a final visual confirmation** — not asserted. Cleanup: the temporary route, page, trigger helper and their 15 tests were deleted and the `App.tsx` wiring reverted — `App.tsx` is now byte-identical to `main`, and `git grep` for the marker/route/message/component over `src/` and `scripts/` returns nothing. Monitoring implementation unchanged. Nothing merged or deployed to Production. | Claude Code |
| 2026-08-10 | 1.3 | Corrected stale wording: §10 said "upload verification pending" and §14 said "source-map upload is not live", both false since rev 1.2 proved the Preview upload green (§9c). Rewrote both to state the upload is verified. Added §13a documenting the runtime symbolication procedure and, explicitly, why it is a signed-in-human step rather than an automated one: the Preview is behind Vercel Deployment Protection (a direct request 302-redirects to a "Login – Vercel" page, confirmed via the in-app browser), and an automated agent must not authenticate with the owner's Vercel/app credentials. Recorded the deliberate decision NOT to add a temporary crash surface — it could not be exercised without that login, so adding-then-removing one would churn history and briefly ship a crash mechanism for zero captured evidence; the final `dev` tree contains no test trigger, which is also the required clean-end state. Runtime symbolication, ErrorBoundary-duplicate and grouping checks are therefore PENDING (manual), while the validation-noise, duplicate-prevention and third-party-filtering behaviours remain covered by the 124 automated monitoring tests. No code change; nothing deployed; no GlitchTip issue modified. | Claude Code |
| 2026-08-10 | 1.2 | Verified the fix on a live Vercel Preview build (commit `5a74815`, deployment `pesowise-saas-8ma5k9z4b`, **● Ready**). The build log shows the full green sequence: 86 maps found → glitchtip-cli v1.0.0 installed and checksum-verified → `glitchtip-cli 1.0.0` executes → 87 files injected → 173 files uploaded for release `5a74815…` → `upload complete.` → 86 `.map` files pruned → Build Completed. Release matches the Vercel Git SHA and the browser `__APP_RELEASE__`; environment resolves to `preview`; the pruned maps plus Vercel Deployment Protection (direct `.map` → 302 to `vercel.com/sso-api`) make them doubly non-public; no token appeared in the log. The reproducible-CLI blocker is resolved end-to-end. Only the manual runtime symbolication test (needs an authenticated session on the SSO-protected preview) and the future Production/main rollout remain. | Claude Code |
| 2026-08-09 | 1.1 | Fixed the first credentialed Preview build (`dpl_3ayjKGjpkCfcFZ4fGXq4jmgqoTw6`, commit `aadfd49`), which generated 86 maps then failed with `glitchtip-cli not found on PATH`: Vercel's build image has no CLI and `curl install.sh | sh` neither pins a version nor keeps the binary on `PATH` between phases. The build now installs the CLI itself — pinned to `CLI_VERSION` v1.0.0 and SHA-256-verified (`de1c035a…`, confirmed end-to-end: HTTP 200, 14,420,352-byte ELF), into gitignored `node_modules/.cache/glitchtip/`, called by absolute path — with precedence PATH → cache → pinned download. Pure decision logic extracted to `scripts/lib/glitchtipCli.mjs`. Behaviour is asymmetric by design: missing credentials SKIP (no install, prune, exit 0) so contributor builds stay green, while a credentialed failure at any step (install/checksum/execute/inject/upload) FAILS the build so a monitored deploy never ships silently unsymbolicated. The token flows only through the child-process environment, never argv/URL/logs. 32 new tests (124 total in the monitoring suites); the local credential-less build was verified to prune all 86 maps and exit 0. Also recorded that the four Vercel variables are now configured (Preview + Production), resolved to org `pesowise` / project `pesowise-web` with the DSN key matching. **Still pending: a live Preview build proving upload succeeds, and the controlled symbolication test. Nothing deployed; no GlitchTip issue modified.** | Claude Code |
| 2026-08-09 | 1.0 | Removed `captureConsoleIntegration` (340 console calls were becoming issues) and the auto-report of all 229 destructive toasts; removed redundant manual registration of integrations that are already defaults in @sentry/react 10.58.0 (verified in the installed source). Added a pure classification module with evidence-based dropping — third-party and bridge noise dropped only when no application frame exists, expected auth recovery dropped while unexpected auth errors still report. Added structured `reportError(error, {area, operation, errorCode…})`, `normalizeError` for Error/Supabase/Auth/string/unknown inputs, stable fingerprints excluding dynamic IDs, ID-only user scope cleared on sign-out, and recursive secret scrubbing. Enabled `sourcemap: "hidden"` with a GlitchTip CLI debug-ID upload script; the build now always prunes `.map` files from `dist/`, including when credentials are absent, because `hidden` prevents the browser requesting them but not their deployment. Injected non-secret `__APP_RELEASE__` / `__APP_DEPLOY_ENV__` so preview and Production are filterable. 92 tests. **Upload credentials still required; nothing deployed; no GlitchTip issue modified.** | Claude Code |
