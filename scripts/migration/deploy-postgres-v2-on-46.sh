#!/usr/bin/env bash
# Deploy PesoWise migration PostgreSQL v2 on .46 (PesoWise-only path).
set -euo pipefail
REMOTE_DIR=/tmp/pesowise-migration-v2
COMPOSE=tools/pesowise-migration/docker-compose.postgres-v2.yml

if [[ -z "${PESOWISE_MIGRATION_DB_PASSWORD:-}" ]]; then
  echo "Set PESOWISE_MIGRATION_DB_PASSWORD in environment (do not commit)." >&2
  exit 1
fi

mkdir -p "$REMOTE_DIR"
cp "$COMPOSE" "$REMOTE_DIR/docker-compose.yml"
export PESOWISE_MIGRATION_DB_PASSWORD
docker compose -f "$REMOTE_DIR/docker-compose.yml" up -d
docker ps --filter name=pesowise-postgres-migration-v2 --format '{{.Names}}|{{.Status}}'
docker exec pesowise-postgres-migration-v2 psql -U pesowise_migration -d pesowise -tAc "SELECT current_setting('server_version');"
