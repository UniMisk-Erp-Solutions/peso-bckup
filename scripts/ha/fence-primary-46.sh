#!/usr/bin/env bash
# Run ON .46 (hasto) — stop primary Postgres to fence before promoting .68.
set -euo pipefail
EXECUTE=0
PRIMARY_DB_CONTAINER="${PRIMARY_DB_CONTAINER:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
CONFIRM="${PESOWISE_FENCE_CONFIRM:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    *) echo "Usage: $0 [--execute]"; exit 1 ;;
  esac
done

echo "fence-primary-46: execute=$EXECUTE container=$PRIMARY_DB_CONTAINER"

verify_down() {
  if timeout 3 bash -c "echo >/dev/tcp/127.0.0.1/5432" 2>/dev/null; then
    return 1
  fi
  return 0
}

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would docker stop $PRIMARY_DB_CONTAINER"
  echo "Post-check: TCP 5432 on .46 must refuse connections"
  exit 0
fi

[[ "$CONFIRM" == "FENCE_46_NOW" ]] || {
  echo "Refusing: set PESOWISE_FENCE_CONFIRM=FENCE_46_NOW" >&2
  exit 1
}

before=$(docker exec "$PRIMARY_DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo stopped)
echo "Before fence: pg_is_in_recovery=$before"

docker stop "$PRIMARY_DB_CONTAINER"
sleep 2

if docker exec "$PRIMARY_DB_CONTAINER" psql -U supabase_admin -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
  echo "FENCE FAIL: container still accepts SQL" >&2
  exit 1
fi

if ! verify_down; then
  echo "FENCE WARN: something still listens on 5432 (pooler?)" >&2
  ss -lntp | grep 5432 || true
  exit 1
fi

echo "FENCE SUCCESS: $PRIMARY_DB_CONTAINER stopped; 5432 closed"
date -u +%Y-%m-%dT%H:%M:%SZ | tee /var/lib/pesowise-ha/fenced-46-at.txt 2>/dev/null || true
