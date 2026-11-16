# Staging RBAC / IDOR validation (Gate I)

**Latest run:** `20260930T065814Z`  
**Report:** `/tmp/pesowise-migration-backup/rbac-gate-i-20260930T065814Z.md`  
**Gate I:** **PASS** (automated matrix)

## Matrix (staging API)

| Case | HTTP | Expected | Result |
|------|------|----------|--------|
| Employee GET own expense | 200 | 200 | PASS |
| Employee GET another user's expense | 403 | 403 | PASS |
| Employee GET /api/admin/users | 403 | 403 | PASS |
| Admin GET /api/admin/users | 200 | 200 | PASS |
| Unauthenticated GET /api/expenses | 401 | 401 | PASS |

## Identity source

All checks use server session cookie (`pesowise_session`); no client-supplied `user_id`.

## Not yet automated

- Full engineer/cashier allow/deny grid
- Tampered path/body UUID substitution suite
- Attachment and notification IDOR per role

Expand in `scripts/migration/run-rbac-gate-i-46.sh` before cutover.
