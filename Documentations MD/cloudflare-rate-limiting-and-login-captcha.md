# Cloudflare rate limiting + login CAPTCHA (Turnstile)

**Doc ID:** DOC-168  
**Status:** in progress (code ready; Cloudflare and Coolify settings pending, need owner keys)  
**Last updated:** 2026-11-27  
**Owner / area:** Security, sign-in, Cloudflare, Supabase Auth (GoTrue)  

---

## 1) Summary

Closes the last open item of the 2026-11-26 pentest follow-up (DOC-167): the employee-ID login returns the employee's e-mail and can be scraped or used to lock a company out of ID login. This needs two things the code cannot do alone: **Cloudflare per-IP rate-limit rules** and **server-side Turnstile CAPTCHA** (keys and settings the owner creates). The application side is done and switched on only when a site key is configured, so nothing changes until then.

---

## 2) Problem / requirement

- `get_employee_auth_email` must stay callable before login (employee-ID login). It is capped per ID (8) and per company (60) per 15 minutes in the database, but there is no per-IP limit, so one attacker can use up a company's whole budget (login lock-out) or harvest e-mails slowly.
- A CAPTCHA that exists only in the browser does not stop scripts. GoTrue must verify the token on the server.
- Per-IP limits cannot be done safely in the database: a company such as MicroLink (459 users) can share one office IP, so DB limits would need to be so high they stop nothing. Cloudflare sees the real client IP and can be tuned from its logs.

---

## 3) Solution

**Code (done, flag-gated by `VITE_TURNSTILE_SITE_KEY`):**
- The sign-in form already renders the Turnstile widget; it now requires the solved token **before** the employee-ID lookup runs (`src/pages/Auth.tsx`).
- GoTrue enforces CAPTCHA on every password grant, so the two other screens that re-check a password now show the widget and send a token too: "change my password" (`Layout.tsx`) and "admin resets a user's password" (`UserManagement.tsx`). Without this, turning on server-side CAPTCHA would have broken both.
- CSP already allows `challenges.cloudflare.com` (script, frame, connect).

**Owner steps (in this order; the order matters, a wrong order locks everyone out):**

1. **Create a Turnstile widget** (Cloudflare dashboard -> Turnstile -> Add widget, mode *Managed*). Hostnames: the backup site and every tenant host that uses it (for example `peso-backup.vercel.app` and the tenant subdomains). Copy the **site key** (public) and the **secret key** (private).
2. **Frontend first:** set `VITE_TURNSTILE_SITE_KEY=<site key>` in the Vercel project (Production) and redeploy. At this point the widget shows and tokens are sent, but the server does not require them yet, so login keeps working.
3. **Then the server:** add to the backup Supabase auth service (Coolify service `kar0ro1k6jiyfxzzw7acnsza`, container `supabase-auth`):
   - `GOTRUE_SECURITY_CAPTCHA_ENABLED=true`
   - `GOTRUE_SECURITY_CAPTCHA_PROVIDER=turnstile`
   - `GOTRUE_SECURITY_CAPTCHA_SECRET=<secret key>`
   Coolify redeploy of this stack currently fails on the missing `minio/mc` image (DOC-167 rev 1.5); apply with the auth-only recreate described there.
4. **Test:** sign in by e-mail, by employee ID, change own password, and admin-reset a user's password. A request to `/auth/v1/token?grant_type=password` without `captchaToken` must now answer `captcha_failed`.
5. **Operational scripts** that sign in by password directly will stop working once step 3 is on: `scripts/tally-integration/create-connector-pairing-code.mjs` and `e2e-daily-sync-deliver-verify.mjs`. Run them with a service-role flow or a pre-minted session instead.

**Cloudflare rate-limiting rules** (zone `unimisk.com`, Security -> WAF -> Rate limiting rules). Start each rule in **Log** mode for a few days, read Security Events, then switch to **Block**. Thresholds below leave room for an office with many people behind one IP; lower them if the logs show real traffic is far under them.

| # | Match (host `pesowise-backup-supabase.unimisk.com`) | Limit per IP | Action |
|---|------|------|------|
| 1 | URI path = `/rest/v1/rpc/get_employee_auth_email` | 60 / minute | Block 10 min |
| 2 | URI path = `/auth/v1/token` | 30 / minute | Block 10 min |
| 3 | URI path in `/rest/v1/rpc/email_can_sign_in_on_tenant`, `/rest/v1/rpc/get_organization_by_subdomain` | 120 / minute | Block 5 min |
| 4 | URI path in `/auth/v1/signup`, `/auth/v1/otp`, `/auth/v1/recover` | 10 / minute | Block 1 hour |

Cloudflare Free allows only one rate-limit rule with a 10-second period; on Free use rule 1 (for example 20 requests / 10 seconds) and put the rest in a custom WAF rule. Rule 4 can also be a custom rule that blocks `/auth/v1/signup` outright (signup is disabled anyway).

---

## 4) Key files

```
src/pages/Auth.tsx                          (CAPTCHA required before the ID lookup)
src/components/Layout.tsx                   (change own password: Turnstile token)
src/pages/UserManagement.tsx                (admin password reset: Turnstile token)
src/components/AuthTurnstile.tsx            (existing widget)
src/lib/turnstile.ts                        (existing flag + helper)
src/lib/__tests__/securityHardeningContract.test.ts
vercel.json                                 (CSP already allows challenges.cloudflare.com)
```

---

## 5) Database / migrations

None. (The per-ID and per-company limits already exist in `get_employee_auth_email`.)

---

## 6) Test plan

- [x] Contract tests pass (CAPTCHA before lookup; widgets in both password dialogs; CSP)
- [ ] Owner sets site key on Vercel, redeploys; widget visible on the sign-in page
- [ ] Sign-in by e-mail and by employee ID works with the widget
- [ ] After GoTrue captcha is on: password grant without token -> `captcha_failed`
- [ ] Change own password and admin reset still work (widget present)
- [ ] Cloudflare rules in Log mode, reviewed, then Block; 70 rapid calls to `get_employee_auth_email` from one IP get blocked

---

## 7) Related docs

- [Security hardening after pentest (DOC-167)](./security-hardening-pentest-2026-11.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-11-27 | 1.0 | Claude Code | Code ready and tested; Cloudflare/Turnstile/Coolify steps documented, awaiting owner keys |
