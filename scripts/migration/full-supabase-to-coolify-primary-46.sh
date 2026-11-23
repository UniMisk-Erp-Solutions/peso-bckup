#!/usr/bin/env bash
# Full PesoWise copy: Supabase (read-only) → Coolify primary Postgres + companion MinIO.
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SRC=supabase-db-kar0ro1k6jiyfxzzw7acnsza
SRC_MINIO=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
TGT=mqgd6kfhdrcbpa2c2bvyjwvc
TGT_MINIO=pesowise-minio-coolify-primary
PG_USER=pesowise_app
PG_DB=pesowise
OUT=/tmp/pesowise-migration-backup/full-coolify-primary-${STAMP}
DUMP="$OUT/pesowise-schemas.dump"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$OUT"
exec > >(tee "$OUT/run.log") 2>&1

echo "FULL_COOLIFY_PRIMARY_START stamp=$STAMP"

echo "=== Phase A: bootstrap target PostgreSQL ==="
docker exec -i "$TGT" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DROP SCHEMA IF EXISTS storage CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO pesowise_app;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "=== Phase B: schema dump from Supabase (public, auth, storage) ==="
docker exec "$SRC" pg_dump -U supabase_admin -d postgres \
  -Fc --no-owner --no-acl \
  -n public -n auth -n storage \
  -f /tmp/pesowise-coolify-schemas.dump
docker cp "$SRC:/tmp/pesowise-coolify-schemas.dump" "$DUMP"
docker exec "$SRC" rm -f /tmp/pesowise-coolify-schemas.dump
sha256sum "$DUMP" > "${DUMP}.sha256"
ls -lh "$DUMP"

echo "=== Phase C: restore into Coolify PostgreSQL ==="
docker cp "$DUMP" "$TGT:/tmp/pesowise-schemas.restore.dump"
set +e
docker exec "$TGT" pg_restore -U "$PG_USER" -d "$PG_DB" \
  --no-owner --role="$PG_USER" -j 1 \
  /tmp/pesowise-schemas.restore.dump 2>"$OUT/pg_restore.stderr"
RESTORE_RC=$?
set -e
grep -vE '^(pg_restore: (warning|error): (role|ACL|extension|schema) .* (does not exist|already exists|not allowed)|$)' \
  "$OUT/pg_restore.stderr" > "$OUT/pg_restore.stderr.filtered" || true
if [[ -s "$OUT/pg_restore.stderr.filtered" ]]; then
  echo "PG_RESTORE_REMAINING_ISSUES (review):"
  tail -30 "$OUT/pg_restore.stderr.filtered"
fi
echo "pg_restore_exit=$RESTORE_RC"
docker exec "$TGT" rm -f /tmp/pesowise-schemas.restore.dump

echo "=== Phase D: companion MinIO for Coolify primary ==="
bash "$SCRIPT_DIR/mirror-minio-to-coolify-primary-46.sh" | tee "$OUT/minio-mirror.log"

echo "=== Phase E: integrity verification ==="
bash "$SCRIPT_DIR/compare-coolify-primary-46.sh" "$OUT/integrity.txt" || INTEGRITY_FAIL=1
INTEGRITY_FAIL=${INTEGRITY_FAIL:-0}

MINIO_ENV=/tmp/pesowise-migration-backup/pesowise-minio-coolify-primary.env
echo "MINIO_API=http://192.168.23.46:19015"
echo "MINIO_CONSOLE=http://192.168.23.46:19016"
echo "MINIO_ENV=$MINIO_ENV"
echo "PG_COOLIFY=192.168.23.46:15435 db=$PG_DB user=$PG_USER"
echo "LOG_DIR=$OUT"
if [[ "$INTEGRITY_FAIL" -ne 0 ]]; then
  echo "FULL_COOLIFY_PRIMARY_FAILED integrity_mismatch=1"
  exit 1
fi
echo "FULL_COOLIFY_PRIMARY_DONE"
