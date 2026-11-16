#!/usr/bin/env bash
# Read-only: map PesoWise-related containers vs Coolify labels (PesoWise scope only).
set -euo pipefail
OUT=/tmp/pesowise-migration-backup/coolify-pesowise-audit-$(date -u +%Y%m%dT%H%M%SZ).txt
exec > >(tee "$OUT") 2>&1

echo "# PesoWise Coolify / container audit (read-only)"

echo "## Production Supabase stack (must remain present)"
docker ps -a --filter name=kar0ro1k6jiyfxzzw7acnsza --format '{{.Names}}|{{.Status}}|{{.Image}}' | head -20

echo "## Migration / new architecture containers"
for n in pesowise-postgres-migration-v2 pesowise-minio-migration-v2 pesowise-api-migration-staging \
  pesowise-react-migration-staging pesowise-frontend-migration-staging pesowise-frontend; do
  docker ps -a --filter name="^${n}$" --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>/dev/null || true
done

echo "## Coolify labels on PesoWise-named containers"
docker ps -a --format '{{.Names}}' | grep -iE 'pesowise|kar0ro1k6jiyfxzzw7acnsza' | while read -r c; do
  proj=$(docker inspect "$c" --format '{{index .Config.Labels "coolify.projectName"}}' 2>/dev/null || echo "")
  svc=$(docker inspect "$c" --format '{{index .Config.Labels "coolify.name"}}' 2>/dev/null || echo "")
  uuid=$(docker inspect "$c" --format '{{index .Config.Labels "coolify.serviceUuid"}}' 2>/dev/null || echo "")
  echo "container=$c coolify_project=${proj:-none} coolify_service=${svc:-none} service_uuid=${uuid:-none}"
done

echo "## pesowise-postgres-migration-v2 persistence"
docker inspect pesowise-postgres-migration-v2 --format 'Mounts={{json .Mounts}}' 2>/dev/null || echo "MISSING"

echo "REPORT=$OUT"
