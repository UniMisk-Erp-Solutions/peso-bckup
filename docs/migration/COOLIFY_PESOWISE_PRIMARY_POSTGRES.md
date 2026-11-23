# Coolify PostgreSQL — Pesowise project

**Created:** 2026-09-30  
**Service name:** `pesowise-primary-postgres`  
**Coolify UUID:** `mqgd6kfhdrcbpa2c2bvyjwvc`  
**Container:** `mqgd6kfhdrcbpa2c2bvyjwvc` (Postgres 15 Alpine)  
**Status:** `running:healthy` in Coolify

## Dashboard links

| View | URL |
|------|-----|
| **PesoWise project** | http://192.168.23.46:8000/project/5yn7eutxo5ztdss21k0retij |
| **Production environment** | http://192.168.23.46:8000/project/5yn7eutxo5ztdss21k0retij/environment/askzkleylrdpnlft0rmjrmlu |
| **PostgreSQL service (open this)** | http://192.168.23.46:8000/project/5yn7eutxo5ztdss21k0retij/environment/askzkleylrdpnlft0rmjrmlu/database/mqgd6kfhdrcbpa2c2bvyjwvc |

Coolify UI base: http://192.168.23.46:8000

## PostgreSQL web dashboard (pgAdmin)

Browse **Coolify Postgres** (`192.168.23.46:15435`, database `pesowise`) in a Studio-like UI:

| Item | Value |
|------|--------|
| **URL** | http://192.168.23.46:5050 |
| **Container** | `pesowise-pgadmin-coolify` |
| **Preconfigured server** | **PesoWise Primary (Coolify)** in the left tree |

pgAdmin login email/password are stored on the server only:

`/tmp/pesowise-migration-backup/pesowise-pgadmin.env`

Redeploy: `scripts/migration/deploy-pesowise-pgadmin-46.sh`

## Full Supabase copy (database + files)

| Component | Endpoint / notes |
|-----------|-------------------|
| **PostgreSQL** | `192.168.23.46:15435`, db `pesowise`, user `pesowise_app` |
| **pgAdmin** | http://192.168.23.46:5050 |
| **MinIO (S3 files)** | API http://192.168.23.46:19015 — console http://192.168.23.46:19016 |
| **Re-sync script** | `scripts/migration/full-supabase-to-coolify-primary-46.sh` |

Copy includes schemas **public**, **auth**, and **storage** (users, rows, bucket metadata). Object bytes are mirrored from Supabase MinIO into `pesowise-minio-coolify-primary` (verify with `compare-coolify-primary-46.sh`).

### See data in pgAdmin (http://192.168.23.46:5050)

1. Log in (credentials in `/tmp/pesowise-migration-backup/pesowise-pgadmin.env` on the server).
2. Left tree: **Servers → PesoWise → PesoWise Primary (Coolify)** — if empty, right-click **Servers → Register → Server**, host `192.168.23.46`, port `15435`, database `pesowise`, user `pesowise_app`.
3. Expand **Databases → pesowise → Schemas**:
   - **public → Tables** — expenses, attachments, profiles, …
   - **auth → Tables** — users, identities, …
   - **storage → Tables** — buckets, objects (file metadata linked to MinIO paths)
4. Right-click a table → **View/Edit Data → All Rows**.

Postgres does not store file bytes; **storage.objects** rows point to paths under MinIO bucket **`stub/storage-single-tenant/`**.

Stack env (Postgres + MinIO for API): run `scripts/migration/write-coolify-primary-stack-env-46.sh` → `/tmp/pesowise-migration-backup/coolify-primary-stack.env`

## Data copy (Supabase → Coolify PG)

Read-only `pg_dump` from `supabase-db-kar0ro1k6jiyfxzzw7acnsza`, `pg_restore` into Coolify DB. **Supabase stack not modified or deleted.**

| Check | Source | Target | Match |
|-------|--------|--------|-------|
| auth.users | 794 | 794 | YES |
| public.expenses | 25,213 | 25,213 | YES |
| SUM(expenses) | 20,989,240.59 | 20,989,240.59 | YES |

Dump: `/tmp/pesowise-migration-backup/supabase-to-coolify-20260930T090001Z.dump`

`pg_restore` reported many errors on Supabase-only extensions/schemas (e.g. `vault.*`); application data counts and financial total match.

## Credentials

Database user/password are in Coolify → **pesowise-primary-postgres** → Configuration (not repeated here).

## Scripts

- `scripts/migration/coolify-deploy-pesowise-postgres-46.sh` — create + deploy in Coolify
- `scripts/migration/copy-supabase-to-coolify-pg-46.sh` — full copy from Supabase
- `scripts/migration/deploy-pesowise-pgadmin-46.sh` — pgAdmin on `:5050`

## Note

Production **`pesowise-api`** still uses **`pesowise-postgres-migration-v2`** (`127.0.0.1:15432`) from the earlier cutover. Point the API at this Coolify instance only when you intentionally switch `DATABASE_URL` to the Coolify internal URL.
