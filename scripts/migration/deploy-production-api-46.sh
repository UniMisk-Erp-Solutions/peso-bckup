#!/usr/bin/env bash
# Production PesoWise API — migration PostgreSQL + MinIO only (never Supabase DB).
set -euo pipefail
STAGING=/tmp/pesowise-migration-staging
BACKEND="$STAGING/backend"
ENV_FILE="$STAGING/.env.production"
CONTAINER=pesowise-api

mkdir -p "$BACKEND"
# shellcheck disable=SC1091
source /tmp/pesowise-migration-v2/.env
# shellcheck disable=SC1091
source /tmp/pesowise-migration-v2-minio/.env

PG_PASS="${POSTGRES_PASSWORD:?}"
MINIO_USER="${MINIO_ROOT_USER:-pesowise_migration}"
MINIO_PASS="${MINIO_ROOT_PASSWORD:?}"

if [[ ! -f "$ENV_FILE" ]]; then
  PROD_SECRET="$(openssl rand -base64 32)"
  printf 'SESSION_SECRET=%s\n' "$PROD_SECRET" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
# shellcheck disable=SC1091
source "$ENV_FILE"

cat > "$ENV_FILE" <<EOF
APP_ENV=production
MIGRATION_STAGE=false
NODE_ENV=production
HOST=0.0.0.0
PORT=8787
DATABASE_URL=postgresql://pesowise_migration:${PG_PASS}@127.0.0.1:15432/pesowise
SESSION_SECRET=${SESSION_SECRET:?}
FRONTEND_ORIGIN=http://192.168.23.46:4173,http://127.0.0.1:4173,https://pesowise.unimisk.com
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
EOF
chmod 600 "$ENV_FILE"

docker rm -f "$CONTAINER" pesowise-api-migration-staging 2>/dev/null || true
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network host \
  -v "$BACKEND:/app" -w /app \
  --env-file "$ENV_FILE" \
  node:22-bookworm-slim \
  sh -c "npm install --omit=dev 2>/dev/null; npm install tsx typescript @types/node @types/bcrypt --no-save && npx tsx src/server.ts"

for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -s http://127.0.0.1:8787/health
echo ""
curl -s http://127.0.0.1:8787/ready
echo ""
echo "DEPLOY_PRODUCTION_API_DONE container=$CONTAINER port=8787"
