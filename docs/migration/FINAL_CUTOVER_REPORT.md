# Final cutover report — PesoWise migration

**Date:** 2026-09-30  
**Host:** `192.168.23.46`  
**Coolify project (Supabase):** `pesowise` / `kar0ro1k6jiyfxzzw7acnsza`

---

## 1. FINAL STATUS

### **BLOCKED**

Production cutover **was not performed**. Production remains on **existing Supabase** + `pesowise-frontend` with **`VITE_SUPABASE_*`**.

**Reason:** Phase 22 / Phase 16 require **all critical gates PASS**, including **Gate O (off-host backup)**. Gate O is **BLOCKED** (`/etc/pesowise-migration/off-host-backup.conf` missing). Gates **J, L, M, N, P** remain **PARTIAL**.

**Precheck:** Infrastructure smoke **PASS** (staging API `/health`, `/ready`, React `:5175`, MinIO live probe, Supabase healthy, `PRODUCTION_CHECK_PASS`).  
**Precheck:** **FINAL_PRE_SWITCH_GATES = FAIL** → cutover **ABORTED** per fail-safe rules.

---

## 2. COOLIFY PESOWISE PROJECT

| Component | Status |
|-----------|--------|
| Preserved Supabase | **Present** — `coolify_project=pesowise`, stack healthy |
| `pesowise-primary-postgres` (Coolify-managed) | **Not created** — cutover blocked before provisioning |
| Production API (Coolify) | **Not deployed** — staging only `:18787` |
| Final `pesowise-minio` (Coolify) | **Not registered** — `pesowise-minio-migration-v2` only |
| Production frontend | **Unchanged** — `pesowise-frontend`, Supabase env |
| Staging React | `pesowise-react-migration-staging` `:5175` |

---

## 3. FINAL DATABASE MIGRATION

No final sync or cutover-target promotion performed (cutover blocked).

Last validated baseline: **0** unexplained public row mismatches, UUIDs preserved, financial totals matched (Gate **E**).

---

## 4. AUTH

Staging API auth gates **G/I PASS**. Production auth **unchanged** (Supabase). No production auth switch.

---

## 5. STORAGE

Baseline: **15,349** physical objects, **~4.7 GiB**, prior **`mc diff = 0`**.  
No final delta sync this pass (cutover blocked).  
`e1a68041…` = **SOURCE_ALREADY_MISSING** (not migration loss).

---

## 6. FULL UI

Gate **L PARTIAL** — full React build on `:5175`; per-role UI matrix **not signed off**.

---

## 7. FINANCIAL WORKFLOW

Gate **P PARTIAL** — not full create→approve lifecycle + concurrency **PASS**.

---

## 8. CONCURRENCY

**Not proven** (Gate **P**).

---

## 9. SSE

Smoke only; full isolation matrix **not signed off**.

---

## 10. PITR

Gate **N PARTIAL/FAIL** — WAL recovery target not reached in last drill.

---

## 11. OFF-HOST BACKUP

**BLOCKED** — no authorized PesoWise off-host destination configured.  
Local `/tmp/pesowise-migration-backup` only — **insufficient for Gate O / Phase 22**.

---

## 12. PRODUCTION CUTOVER

| Step | Result |
|------|--------|
| Maintenance freeze | **Not started** |
| Final sync | **Not performed** |
| Frontend `VITE_API_URL` | **Not applied** |
| Production API deploy | **Not performed** |
| Routing switch | **Not performed** |
| Smoke on new stack | **N/A** |

---

## 13. PRODUCTION RUNTIME AUDIT

Post-cutover audit **N/A** (no switch).  
Gate **M** (pre-switch): runtime browser proof **incomplete**.

---

## 14. CHANGED FILES

This pass: **`docs/migration/FINAL_CUTOVER_REPORT.md`** only (no production config changes).

---

## 15. NEW PESOWISE RESOURCES

**None** created in this cutover attempt (blocked before Phase 2 registration).

---

## 16. UNRELATED INFRASTRUCTURE CHANGES

**NONE**

---

## 17. SOURCE SUPABASE PRESERVATION

| Check | Value |
|-------|--------|
| STACK PRESENT | **YES** |
| POSTGRES PRESENT | **YES** |
| AUTH DATA PRESENT | **YES** |
| STORAGE PRESENT | **YES** |
| MINIO OBJECTS PRESENT | **YES** |
| VOLUMES PRESENT | **YES** |
| DATA DELETED | **NO** |
| OBJECTS DELETED | **NO** |
| VOLUMES DELETED | **NO** |
| ROLLBACK COPY PRESERVED | **YES** |

No destructive action taken against Supabase.

---

## 18. ACTIVE PRODUCTION ARCHITECTURE (unchanged)

**Browser → Supabase** (Kong/Auth/PostgREST/Storage) via `pesowise-frontend` **`VITE_SUPABASE_*`**.

---

## 19. OLD ARCHITECTURE

Same as active today — **Supabase remains authoritative** and **preserved**.

---

## 20. FINAL RESULT

**NOT:** `PESOWISE MIGRATION COMPLETE` / new stack active.

**IS:** **CUTOVER BLOCKED** — resolve **O**, **J, L, M, N, P**, Coolify registration of final Postgres/API/MinIO, and full backend/UI validation; then re-run this cutover prompt.

**Old Supabase:** intact. **New stack:** staging-only, not production.

---

## Unblock checklist (operator)

1. Authorize off-host backup path + `off-host-backup.conf` (Gate **O**).
2. Complete gates **J, L, M, N, P** with evidence.
3. Register **pesowise-primary-postgres** + production API + MinIO in Coolify **pesowise** project.
4. Complete backend API for all production UI domains.
5. Re-run final backup → freeze → delta sync → Phase 22 gate table all **PASS** → cutover.
