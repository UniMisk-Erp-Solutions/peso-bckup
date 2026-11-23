#!/usr/bin/env bash
set -euo pipefail
cd /tmp/pesowise-migration-v2
if [[ ! -f .env ]]; then
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 32)" > .env
  chmod 600 .env
fi
set -a
# shellcheck disable=SC1091
source ./.env
set +a
docker compose -f docker-compose.yml up -d
docker ps --filter name=pesowise-postgres-migration-v2 --format '{{.Names}}|{{.Status}}|{{.Ports}}'
docker exec pesowise-postgres-migration-v2 pg_isready -U pesowise_migration -d pesowise
