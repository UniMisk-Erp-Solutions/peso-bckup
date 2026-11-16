# PITR production readiness

**Status: NOT PRODUCTION-READY** (2026-09-25)

## Success criteria checklist

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Isolated restore works | **PASS** in Docker lab (`run-e2e-pitr-test.sh`) |
| 2 | Base backup verifies | Tooling ready; **prod base chain BLOCKED** |
| 3 | WAL chain covers target | **FAIL on prod** (`archive_mode=off`) |
| 4 | Recovery reaches target time | **PASS in lab** |
| 5 | 1000/1000 fixtures return | **PASS in lab** (fixture schema) |
| 6 | Dependent rows return | **PASS in lab** (EFV) |
| 7 | Post-target rows excluded | Not fully asserted in lab v1 |
| 8 | Frontend reads recovery DB | **NOT RUN** (needs recovery Supabase stack) |
| 9 | Never touches production | **PASS** |
| 10 | Partial recovery bundle | Documented; script stub |
| 11 | RPO/RTO measured | **BLOCKED** on prod |
| 12 | Health checks exist | `check-pitr-health.sh` |
| 13 | Runbook complete | `PITR_RUNBOOK.md` |
| 14 | Destructive prod disabled | **PASS** |

## Manual production steps (after approval only)

1. Read-only audit (`PITR_CURRENT_STATE_AUDIT.md`)  
2. Enable WAL retention (physical slot + `pg_receivewal` **or** `archive_mode`)  
3. Scheduled `create-base-backup.sh --execute`  
4. Restore **historical** timestamp to isolated host — validate **real** data  
5. Never run 500+500 delete on production  

See sections A–R in this file’s companion docs under `docs/recovery/`.
