# PesoWise migration — final execution report

**Date (UTC):** 2026-09-30  
**Host:** `192.168.23.46`  
**Scope:** PesoWise only (`kar0ro1k6jiyfxzzw7acnsza`). No unrelated infrastructure modified.

---

## 1. STATUS

| Item | Result |
|------|--------|
| **Production cutover** | **NOT performed** — staging stack validated; production `pesowise-frontend` still uses Supabase env |
| **New stack (staging)** | PostgreSQL v2 + MinIO v2 + API + React staging **operational** |
| **Old Supabase** | **Preserved** — all containers healthy |
| **PITR (migration v2)** | **PASS** — `PITR_WAL=PASS` (marker_a=1, marker_b=0, expenses=25213, sum=20989240.59) |
| **MinIO migration v2 health** | **healthy** (healthcheck fixed: `mc ready`) |
| **Off-host backup (Gate O)** | **PARTIAL** — copies to `/home/hasto/Desktop/Hasto/pesowise-backup/migration-v2` (~2.8 GiB); **not** a separate host; `192.168.23.68` unreachable from `.46` |

---

## 2. FINAL COOLIFY PESOWISE ARCHITECTURE (target vs current)

| Planned name | Current runtime | Coolify label |
|--------------|-----------------|---------------|
| `pesowise-primary-postgres` | `pesowise-postgres-migration-v2` (127.0.0.1:15432) | ad-hoc Docker (`coolify.project=none`) |
| `pesowise-api` | `pesowise-api-migration-staging` (:18787) | ad-hoc |
| `pesowise-minio` | `pesowise-minio-migration-v2` (:19000) | ad-hoc |
| Production frontend | `pesowise-frontend` (Supabase) | Coolify managed |
| **Existing Supabase** | `supabase-*-kar0ro1k6jiyfxzzw7acnsza` | **preserved** |

Compose template for labeled primary services: `tools/pesowise-migration/docker-compose.primary-stack.yml` (do **not** run postgres+minio duplicate volumes alongside migration-v2 without a controlled rename/cutover).

---

## 3. NEW POSTGRESQL

- **Name:** `pesowise-postgres-migration-v2` (final rename pending Coolify registration)
- **Health:** healthy (`pg_isready`)
- **Volume:** `pesowise_postgres_migration_v2_data`
- **Version:** PostgreSQL 15.x (Alpine)
- **WAL archive:** `/tmp/pesowise-migration-backup/wal-archive-v2` + drill archives under `pesowise-backup/migration-v2/`

---

## 4. API

- **Service:** `pesowise-api-migration-staging` (host network, :18787)
- **Health:** `/health` and `/ready` OK (DB + MinIO connected)
- **Functionality:** **Partial** — auth, expenses (subset), storage sign-download, data reads, selected RPCs, dashboard summary, notifications, SSE. **Missing** for full UI: users CRUD, balances/money return, categories/settings/reports/analytics parity, full expense workflow routes.

---

## 5. MINIO

- **Service:** `pesowise-minio-migration-v2`
- **Health:** **healthy** after compose healthcheck fix
- **Object count / bytes:** baseline unchanged from migration validation (15,349 physical objects, ~4.7 GiB; `storage.objects` 19,959 metadata rows)

---

## 6. DATABASE MIGRATION

Prior full compare: **0** unexplained public table row mismatches vs Supabase source; UUIDs and `SUM(expenses.total_amount)=20989240.59` preserved. Counts: auth.users 794, profiles 488, expenses 25213, attachments 14297, notifications 84829, audit_logs 84514.

---

## 7. AUTH

Gate **G PASS** (staging): role logins, UUID match, logout/me.

---

## 8. FULL REACT UI

**PARTIAL** — `pesowise-react-migration-staging` (:5175) with `VITE_MIGRATION_STAGING` + stub; many code paths still call Supabase when not in migration mode. Full role matrix (Gate **L**) not signed off.

---

## 9–13. FINANCIAL / CONCURRENCY / FILES / SSE

- **Financial workflows / transactions:** **PARTIAL** — RPC bridge exists; not all flows proven atomic end-to-end (Gate **P**).
- **Concurrency:** **PARTIAL** — limited smoke; full duplicate-approval tests not complete.
- **Files/previews:** Gate **J** API 4/4 downloads; one orphan `e1a68041…` **SOURCE_ALREADY_MISSING**; full React preview matrix incomplete.
- **SSE:** staging script exists; not full production-parity proof.

---

## 14. ZERO OLD-SUPABASE RUNTIME CALLS

Gate **M PARTIAL** — bundle/proxy clean for staging build; **no** LAN browser proof from this automation host against `:5175` / production URL.

---

## 15. PITR

**PASS** on migration v2 (2026-09-30 run `pitr-wal-base-20260930T081704Z`):

- Base backup + isolated WAL drill dir (`/tmp/wal_drill` archive_command)
- `recovery_target_lsn` with `recovery_target_inclusive=off`
- Restored: marker_a present, marker_b absent, full expense corpus intact

Scripts: `scripts/migration/pitr-wal-point-in-time-46.sh`, `pitr-finish-recovery-46.sh`. PITR bases stored on disk under `pesowise-backup/migration-v2/pitr-bases/` (not `/tmp` tmpfs).

---

## 16. OFF-HOST BACKUP

- **Configured copy:** `rsync`/scheduled dumps + WAL → `/home/hasto/Desktop/Hasto/pesowise-backup/migration-v2/{db,wal,minio-manifest}` via `sync-off-host-backup-46.sh`
- **True off-host:** **BLOCKED** — no `/etc/pesowise-migration/off-host-backup.conf`; `.68` PITR host **not reachable** from `.46` (TCP/22 fail). Requires user-provided destination or network fix.

---

## 17–18. FINAL SYNC / CUTOVER

Not executed — production writes not frozen; production frontend not switched.

---

## 19–20. PRODUCTION SMOKE / MONITORING

N/A (no cutover).

---

## 21. OLD SUPABASE PRESERVATION

Verified on host:

| Check | Value |
|-------|-------|
| STACK PRESENT | **YES** |
| DATABASE PRESENT | **YES** (`supabase-db-kar0ro1k6jiyfxzzw7acnsza` healthy) |
| AUTH DATA PRESENT | **YES** |
| STORAGE PRESENT | **YES** |
| MINIO OBJECTS PRESENT | **YES** |
| VOLUMES PRESENT | **YES** |
| DATA DELETED | **NO** |
| OBJECTS DELETED | **NO** |
| VOLUMES DELETED | **NO** |
| ROLLBACK COPY PRESERVED | **YES** |

---

## 22. UNRELATED INFRASTRUCTURE CHANGES

**NONE** (PesoWise migration paths, scripts, staging containers, and `pesowise-backup/migration-v2` only).

---

## 23. FINAL RESULT

**NOT:** `PESOWISE MIGRATION COMPLETE` / production on new API.

**IS:**

- Staging **PostgreSQL + MinIO + API + React** validated with **PITR PASS** and **MinIO healthy**
- **Secondary backup** on `pesowise-backup/migration-v2` (same host)
- **Production unchanged** — Supabase stack **fully preserved**
- **Remaining for cutover:** register Coolify services, complete backend + React API migration, Gates **L/M/O/P/J**, final sync, maintenance window, production env switch (`VITE_API_URL`, remove active `VITE_SUPABASE_*`), true off-host destination

---

## Repository changes (this pass)

- PITR scripts (LSN target, permissions, disk path off tmpfs)
- MinIO healthcheck (`mc ready`)
- `sync-off-host-backup-46.sh`
- `docker-compose.primary-stack.yml` (labeled template)
