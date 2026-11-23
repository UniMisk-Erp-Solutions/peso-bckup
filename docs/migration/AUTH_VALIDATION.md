# Auth validation (Gate G)

**Latest run:** `20260930T065813Z` on `192.168.23.46`  
**Report:** `/tmp/pesowise-migration-backup/auth-gate-g-20260930T065813Z.md`  
**Gate G:** **PASS** (required role/session matrix)

## Scope

Staging API only: `http://127.0.0.1:18787`  
Migration DB: `pesowise-postgres-migration-v2`  
Production Supabase DB read-only for UUID comparison only.

## Role login matrix

| Role | Source UUID = target UUID | Login | GET /api/auth/me | Result |
|------|---------------------------|-------|------------------|--------|
| admin | yes | 200 | 200 | PASS |
| engineer | yes | 200 | 200 | PASS |
| employee | yes | 200 | 200 | PASS |
| cashier | yes | 200 | 200 | PASS |

## Session / negative tests

| Test | Expected | Actual | Result |
|------|----------|--------|--------|
| POST logout | 200 | 200 | PASS |
| GET /api/auth/me after logout (no cookie) | 401 | 401 | PASS |
| Relogin + /me | 200 | 200 | PASS |
| Invalid credentials | 401 | 401 | PASS |
| Unauthenticated GET /api/expenses | 401 | 401 | PASS |

## Not automated this pass

- Session expiry timing
- Session refresh (if distinct from cookie TTL)
- Disabled/inactive user
- Cookie flag audit (manual browser recommended)

## Backend fixes applied (staging)

- `loadAuthUser` resolves `organization_id` via profile, membership, expenses, attachments; legacy admin fallback when profile missing.
- Logout clears signed session cookie (`clearCookie` with `signed: true`).

## Credentials

Staging test passwords are set only in host env (`STAGING_TEST_PASSWORD`); not recorded here.
