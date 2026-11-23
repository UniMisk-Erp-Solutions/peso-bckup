#!/usr/bin/env bash
# PesoWise production cutover — preserves Supabase stack (read-only source backup + optional resync).
set -euo pipefail
REPO="${REPO_ROOT:-/tmp/pesowise-migration-staging/frontend-src}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG=/tmp/pesowise-migration-backup/cutover-${STAMP}.log
exec > >(tee "$LOG") 2>&1

echo "CUTOVER_START=$STAMP"

echo "=== Phase 20: pre-switch source backup (read-only dump) ==="
bash "$SCRIPT_DIR/pesowise-pg-dump-46.sh" || bash "$SCRIPT_DIR/setup-v2-backup-pitr-46.sh"

echo "=== Phase 21–22: compare + final sync if needed ==="
CMP="/tmp/pesowise-migration-backup/pre-cutover-compare-${STAMP}.txt"
bash "$SCRIPT_DIR/compare-source-target-46.sh" | tee "$CMP"
if awk -F'|' '$NF=="NO"{exit 1} END{exit 0}' "$CMP" 2>/dev/null; then
  echo "Counts match — skipping full pg_restore resync."
else
  echo "Mismatch — final sync from Supabase (source read-only)."
  bash "$SCRIPT_DIR/final-sync-source-to-v2-46.sh"
fi

echo "=== Phase 24: production API ==="
bash "$SCRIPT_DIR/deploy-production-api-46.sh"

echo "=== Phase 24: production frontend (4173) ==="
export VITE_API_URL="${VITE_API_URL:-http://192.168.23.46:8787}"
export VITE_PUBLIC_SITE_URL="${VITE_PUBLIC_SITE_URL:-http://192.168.23.46:4173}"
COMPOSE="$REPO/tools/pesowise-migration/docker-compose.production-cutover.yml"
docker rm -f pesowise-frontend 2>/dev/null || true
docker compose -f "$COMPOSE" build
docker compose -f "$COMPOSE" up -d

sleep 5
curl -sf -o /dev/null -w "frontend_http=%{http_code}\n" http://127.0.0.1:4173/
curl -sf http://127.0.0.1:8787/health

echo "=== Phase 25–26: smoke + network ==="
bash "$SCRIPT_DIR/run-network-runtime-audit-46.sh" || true
PESOWISE_AUDIT_API=http://127.0.0.1:8787 PESOWISE_AUDIT_REACT=http://127.0.0.1:4173 bash "$SCRIPT_DIR/run-network-runtime-audit-46.sh" || true
bash "$SCRIPT_DIR/verify-post-cutover-46.sh"

echo "=== Phase 28: Supabase preservation ==="
docker ps --filter name=kar0ro1k6jiyfxzzw7acnsza --format '{{.Names}}|{{.Status}}' | head -5

echo "CUTOVER_COMPLETE log=$LOG"
