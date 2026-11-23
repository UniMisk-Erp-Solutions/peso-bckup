#!/usr/bin/env bash
set -euo pipefail
cd /tmp/pesowise-migration-v2-minio
if [[ ! -f .env ]]; then
  {
    printf 'MINIO_ROOT_USER=pesowise_migration\n'
    printf 'MINIO_ROOT_PASSWORD=%s\n' "$(openssl rand -base64 24)"
  } > .env
  chmod 600 .env
fi
docker compose -f docker-compose.yml up -d
docker ps --filter name=pesowise-minio-migration-v2 --format '{{.Names}}|{{.Status}}'
