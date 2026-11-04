# DOC-151 — Stale dynamic-import (chunk) recovery

Last updated: 2026-10-27

## Summary
After a deployment the previous build's hashed chunks are removed. A tab opened on the old build that lazy-imports one (e.g. `/assets/Balances-<hash>.js`) fails with `error loading dynamically imported module` (Firefox) / `Failed to fetch dynamically imported module` (Chromium) / `Importing a module script failed` (Safari).

## Evidence (Production, 2026-10-27)
- A removed hashed chunk returns **HTTP 404, `text/plain`** (the SPA rewrite excludes `/assets/`), so the failure is a 404, not an HTML-as-JS parse error.
- `index.html`, `/` and `sw.js`: `no-cache, no-store, must-revalidate`. `/assets/*`: `public, max-age=31536000, immutable`. Correct model; unchanged.
- The 404 for a removed chunk is itself served with the `immutable` header (the `/assets/(.*)` rule applies to 404s). Harmless for old hashes; noted, not changed (do not disable caching globally).
- A service worker exists (`public/sw.js`, `registerPwaServiceWorker`). It bypasses `/assets/`, serves documents network-first, and only falls back to a cached `index.html` when the network fails. It does not serve chunks, so it is not the cause; it can only serve a stale shell when offline.
- Classification: **A — 404 old hashed chunk** (version skew across several Production deployments on 2026-10-26/27). Per-deployment file trees are not retrievable from Vercel for old deployments, and the user's exact hash was not supplied, so the old filename itself is not independently proven.

## Existing recovery (since 2026-08-10)
`src/lib/chunkRecovery.ts` (narrow classifier, one guarded reload primitive), `lazyWithRetry` (one in-place retry, then the guarded reload), `vite:preloadError` handler, `ErrorBoundary`.

## Change
- Recovery flag renamed `pw_chunk_reload_attempted` (sessionStorage). ONE automatic reload; cleared by the next successful dynamic import; 10-minute safety expiry (was a 30 s cooldown that allowed a second automatic reload).
- `ErrorBoundary` shows a dedicated screen for a stale-chunk error: "A new version is available", message and a **Reload now** button (user-initiated, always allowed). After the automatic reload was used: "A new version of PesoWise was deployed. Please refresh the page."
- Only module/chunk-load failures trigger it. API, auth, database, validation and render errors never reload.

## Key files
`src/lib/chunkRecovery.ts`, `src/components/ErrorBoundary.tsx`, `src/lib/__tests__/balancesChunkRecovery.test.tsx`.

## Database
None.

## Test plan
`balancesChunkRecovery.test.tsx` (7), `chunkRecovery.test.ts`, `lazyWithRetry.test.tsx`, `ErrorBoundary.test.tsx`.

## Revision log
| Date | Rev | Change | By |
|------|-----|--------|----|
| 2026-10-27 | 1.0 | Evidence, one-attempt flag, new-version boundary UI, tests. | Claude Code |
