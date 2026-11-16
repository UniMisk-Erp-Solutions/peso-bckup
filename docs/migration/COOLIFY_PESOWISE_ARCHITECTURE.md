# PesoWise Coolify project architecture (read-only audit)

**Host:** `192.168.23.46`  
**Audit:** `/tmp/pesowise-migration-backup/coolify-pesowise-audit-20260930T072728Z.txt`

## Existing Supabase (PRESERVE — Coolify project `pesowise`)

| Component | Container pattern | Coolify |
|-----------|-------------------|---------|
| Full Supabase stack | `*-kar0ro1k6jiyfxzzw7acnsza` | `coolify_project=pesowise` |
| Production frontend | `pesowise-frontend` | No Coolify label (Compose-managed) |

**Status:** All Supabase containers **Up / healthy**. **Not deleted. Not modified** this pass.

## New architecture (currently **outside** Coolify UI labels)

| Resource | Container | Persistent volume | Port (localhost) |
|----------|-----------|-------------------|------------------|
| PostgreSQL (validated clone) | `pesowise-postgres-migration-v2` | `pesowise_postgres_migration_v2_data` | `15432` |
| MinIO (copied objects) | `pesowise-minio-migration-v2` | (inspect separately) | `19000` |
| Staging API | `pesowise-api-migration-staging` | bind `/tmp/pesowise-migration-staging/backend` | `18787` |
| Full React staging | `pesowise-react-migration-staging` | image-only | `5175` |

**Coolify labels:** `coolify_project=none` on all new-stack containers → **ad-hoc Docker**, not yet registered as Coolify services.

## Phase 1 outcome

**Recommended final name:** `pesowise-primary-postgres` (Coolify-managed)  
**Current validated data:** already on volume `pesowise_postgres_migration_v2_data` via `pesowise-postgres-migration-v2`.

**Safe next step (operator / Coolify UI — not executed automatically):**

1. Add **Database** resource in Coolify project **pesowise** pointing at the same volume/data path **or** restore once into a new Coolify Postgres service.
2. Register API, MinIO, and production frontend as separate Coolify services.
3. **Do not** remove or replace Supabase service `kar0ro1k6jiyfxzzw7acnsza`.

Automated Coolify provisioning was **not** performed (no API token / risk of wrong project).

## Both databases must coexist

| Database | Role |
|----------|------|
| Supabase Postgres (`supabase-db-kar0ro1k6jiyfxzzw7acnsza`) | **Preserved** source / rollback |
| `pesowise-postgres-migration-v2` | Validated **future primary** candidate |

Connection variable for future API (names only): `DATABASE_URL` → dedicated Postgres on private network.
