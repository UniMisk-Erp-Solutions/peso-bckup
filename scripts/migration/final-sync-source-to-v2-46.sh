#!/usr/bin/env bash
# Final delta sync: COPY from production Supabase DB → migration v2 (source never modified).
set -euo pipefail
SRC=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TGT=pesowise-postgres-migration-v2
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/tmp/pesowise-migration-backup/final-sync-${STAMP}
mkdir -p "$OUT"

echo "FINAL_SYNC_START stamp=$STAMP"
docker exec "$SRC" pg_dump -U supabase_admin -d postgres -Fc -f /tmp/pesowise-final-${STAMP}.dump
docker cp "$SRC:/tmp/pesowise-final-${STAMP}.dump" "$OUT/pesowise-final.dump"
sha256sum "$OUT/pesowise-final.dump" > "$OUT/pesowise-final.sha256"
pg_restore --list "$OUT/pesowise-final.dump" | wc -l | tee "$OUT/restore-list-count.txt"

docker cp "$OUT/pesowise-final.dump" "$TGT:/tmp/pesowise-final.dump"
docker exec "$TGT" pg_restore -U pesowise_migration -d pesowise --clean --if-exists --no-owner --role=pesowise_migration -j 4 /tmp/pesowise-final.dump || true
docker exec "$TGT" rm -f /tmp/pesowise-final.dump

bash "$(dirname "$0")/compare-source-target-46.sh" | tee "$OUT/compare-after.txt"
echo "FINAL_SYNC_DONE out=$OUT"
