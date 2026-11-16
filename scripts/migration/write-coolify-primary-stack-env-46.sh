#!/usr/bin/env bash
# Write env file linking Coolify Postgres + Coolify MinIO (for API / operators).
set -euo pipefail
OUT=/tmp/pesowise-migration-backup/coolify-primary-stack.env
PG_PASS=$(docker inspect mqgd6kfhdrcbpa2c2bvyjwvc --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
# shellcheck disable=SC1091
source /tmp/pesowise-migration-backup/pesowise-minio-coolify-primary.env
cat > "$OUT" <<EOF
# Coolify primary stack — Postgres metadata + MinIO object files (copy from Supabase)
DATABASE_URL=postgresql://pesowise_app:${PG_PASS}@127.0.0.1:15435/pesowise
MINIO_ENDPOINT=http://127.0.0.1:19015
MINIO_ACCESS_KEY=${MINIO_ROOT_USER}
MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD}
MINIO_BUCKET=stub
MINIO_OBJECT_PREFIX=storage-single-tenant
EOF
chmod 600 "$OUT"
echo "STACK_ENV=$OUT"
echo "COOLIFY_PRIMARY_STACK_ENV_DONE"
