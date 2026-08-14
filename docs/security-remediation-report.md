# Security And Performance Remediation Report

Date: 2026-04-28

## Implemented Changes

### 1) Headers And Browser Isolation

- Updated [`vercel.json`](../vercel.json) with:
  - `Strict-Transport-Security`
  - `Permissions-Policy`
  - `Cross-Origin-Opener-Policy`
  - `Cross-Origin-Resource-Policy`
  - `Cross-Origin-Embedder-Policy`
  - Existing `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` retained
- Added canonical host redirect:
  - `www.pesowise.unimisk.com` -> `pesowise.unimisk.com`

### 2) CSP Rollout

- Added enforced `Content-Security-Policy` header in [`vercel.json`](../vercel.json).
- Added `Content-Security-Policy-Report-Only` header with stricter directives for progressive tightening.
- Included `upgrade-insecure-requests` in both policies.
- **Self-hosted Supabase (Coolify):** `connect-src`, `frame-src`, `img-src`, and `media-src` include explicit `https://pesowise-supabase.unimisk.com` and `wss://pesowise-supabase.unimisk.com`, plus `https://*.unimisk.com` / `wss://*.unimisk.com` alongside `*.supabase.co`. CSP is defined only in [`vercel.json`](../vercel.json) (no meta tag in `index.html`). Redeploy Vercel after changes.

### 3) Canonicalization

- Hardened site origin normalization in [`src/lib/siteConfig.ts`](../src/lib/siteConfig.ts):
  - Force HTTPS origin
  - Remove `www.` prefix
  - Remove query/hash from canonical origin

### 4) Auth And Authorization Hardening

- Strengthened org-scoped authorization in [`supabase/functions/admin-reset-password/index.ts`](../supabase/functions/admin-reset-password/index.ts):
  - Caller must be active admin
  - Target user must belong to one of caller's admin orgs
- Added UUID validation in [`supabase/functions/admin-update-user-email/index.ts`](../supabase/functions/admin-update-user-email/index.ts).

### 5) Validation And Injection Surface Reduction

- Added row limits and stricter validation in:
  - [`supabase/functions/bulk-users-import/index.ts`](../supabase/functions/bulk-users-import/index.ts)
  - [`supabase/functions/bulk-categories-import/index.ts`](../supabase/functions/bulk-categories-import/index.ts)
  - [`supabase/functions/bulk-field-definitions-import/index.ts`](../supabase/functions/bulk-field-definitions-import/index.ts)
  - [`supabase/functions/bulk-field-values-import/index.ts`](../supabase/functions/bulk-field-values-import/index.ts)
- Hardened upload payload handling in [`supabase/functions/compress-upload/index.ts`](../supabase/functions/compress-upload/index.ts):
  - base64 input pattern validation
  - sanitized filename

### 6) Performance Optimizations

- Added lazy loading/async decoding where applicable:
  - [`src/components/marketing/MarketingFooter.tsx`](../src/components/marketing/MarketingFooter.tsx)
  - [`src/components/AppSidebar.tsx`](../src/components/AppSidebar.tsx)
  - [`src/components/Layout.tsx`](../src/components/Layout.tsx)
  - [`src/components/marketing/GifSlot.tsx`](../src/components/marketing/GifSlot.tsx)
  - [`src/pages/Auth.tsx`](../src/pages/Auth.tsx)
- Removed unnecessary Google Fonts preconnect hints in [`index.html`](../index.html).
- Added build chunking strategy in [`vite.config.ts`](../vite.config.ts) to reduce render-blocking risk from large vendor bundles.

## Baseline Artifacts

- Non-breakable flows baseline: [`docs/security-baseline.md`](./security-baseline.md)
- Conflict tracking log: [`docs/security-conflicts.md`](./security-conflicts.md)

## Verification Summary

- `npm run build`: passed
- `npm run lint`: fails due to pre-existing repo-wide lint debt (logged in conflict log)
- `npm run test -- --run`: fails due to pre-existing integration test setup issues (logged in conflict log)

## TLS/Protocol Verification Notes

- Code-level and header-level hardening was implemented in app config.
- External network TLS probing from this environment timed out; production TLS posture should be validated from CI or external scanner.
- Recommended external checks:
  - SSL Labs scan for protocol/cipher posture
  - SecurityHeaders scan for header confirmation post-deploy
  - Verify no alternate host serves weaker TLS/certs

## Deployment Follow-ups

1. Deploy Vercel config/header changes.
2. Deploy updated Supabase edge functions.
3. Re-run external header/TLS scans on live domain.
4. Resolve open items in [`docs/security-conflicts.md`](./security-conflicts.md) to restore full automated regression confidence.

