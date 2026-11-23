#!/usr/bin/env bash
# Deploy PesoWise staging API on .46 — port 18787, migration DB/MinIO only.
set -euo pipefail
STAGING=/tmp/pesowise-migration-staging
BACKEND="$STAGING/backend"
ENV_FILE="$STAGING/.env.staging"
CONTAINER=pesowise-api-migration-staging

mkdir -p "$BACKEND"
if [[ ! -f "$BACKEND/package.json" ]]; then
  echo "Missing $BACKEND/package.json — upload backend tarball first." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /tmp/pesowise-migration-v2/.env
# shellcheck disable=SC1091
source /tmp/pesowise-migration-v2-minio/.env

PG_PASS="${POSTGRES_PASSWORD:?}"
MINIO_USER="${MINIO_ROOT_USER:-pesowise_migration}"
MINIO_PASS="${MINIO_ROOT_PASSWORD:?}"

STAGING_SECRET="${STAGING_SESSION_SECRET:-$(openssl rand -base64 32)}"
STAGING_TEST_PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"

cat > "$ENV_FILE" <<EOF
APP_ENV=staging
MIGRATION_STAGE=true
NODE_ENV=development
HOST=0.0.0.0
PORT=18787
DATABASE_URL=postgresql://pesowise_migration:${PG_PASS}@127.0.0.1:15432/pesowise
SESSION_SECRET=${STAGING_SECRET}
FRONTEND_ORIGIN=http://127.0.0.1:5174,http://127.0.0.1:5175
MINIO_ENDPOINT=http://127.0.0.1:19000
MINIO_ACCESS_KEY=${MINIO_USER}
MINIO_SECRET_KEY=${MINIO_PASS}
MINIO_BUCKET=stub
MINIO_OBJECT_PREFIX=storage-single-tenant
FORBIDDEN_SUPABASE_HOST=pesowise-backup-supabase
FORBIDDEN_SUPABASE_DB_CONTAINER=supabase-db-kar0ro1k6jiyfxzzw7acnsza
FORBIDDEN_PRODUCTION_MINIO_CONTAINER=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
EXPECTED_DB_CONTAINER=pesowise-postgres-migration-v2
EXPECTED_MINIO_CONTAINER=pesowise-minio-migration-v2
STAGING_TEST_PASSWORD=${STAGING_TEST_PW}
EOF
chmod 600 "$ENV_FILE"

docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network host \
  -v "$BACKEND:/app" -w /app \
  --env-file "$ENV_FILE" \
  node:22-bookworm-slim \
  sh -c "npm install --omit=dev 2>/dev/null; npm install tsx typescript @types/node @types/bcrypt --no-save && npx tsx src/server.ts"

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18787/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "=== health ==="
curl -s http://127.0.0.1:18787/health || true
echo ""
curl -s http://127.0.0.1:18787/ready || true
echo ""
echo "DEPLOY_STAGING_API_DONE container=$CONTAINER"
