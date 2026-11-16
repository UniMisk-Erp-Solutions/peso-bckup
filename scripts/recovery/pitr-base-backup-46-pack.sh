#!/usr/bin/env bash
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TS=$(date -u +%Y%m%dT%H%M%SZ)
WORKDIR=/tmp/pitr-base-pack-$TS
mkdir -p "$WORKDIR/data"
docker exec "$DB" bash -lc 'rm -rf /tmp/pitr-base-local && runuser -u postgres -- pg_basebackup -D /tmp/pitr-base-local -Fp -Xs -P'
docker cp "$DB:/tmp/pitr-base-local/." "$WORKDIR/data/"
test -f "$WORKDIR/data/PG_VERSION" || { echo "FAIL: PG_VERSION missing after basebackup"; exit 1; }
rm -f "$WORKDIR/data/standby.signal" 2>/dev/null || true
echo ok >"$WORKDIR/SUCCESS"
tar -czf "/tmp/pitr-base-${TS}.tar.gz" -C /tmp "pitr-base-pack-$TS"
echo "/tmp/pitr-base-${TS}.tar.gz"
echo "TS=$TS"
