#!/usr/bin/env bash
# Copy WAL segments from .46 primary pg_wal into a tarball for .68 pitr-wal backfill.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
OUT=/tmp/pitr-wal-backfill
rm -rf "$OUT" && mkdir -p "$OUT"
# From last good archive through current (timeline 2).
for hex in D8 D9 DA DB DC DD DE DF E0 E1 E2 E3 E4 E5 E6 E7 E8 E9 EA EB EC ED EE EF F0 F1 F2 F3 F4; do
  f="0000000200000000000000${hex}"
  docker cp "$DB:/var/lib/postgresql/data/pg_wal/$f" "$OUT/" 2>/dev/null || true
done
docker cp "$DB:/var/lib/postgresql/data/pg_wal/00000002.history" "$OUT/" 2>/dev/null || true
rm -f "$OUT"/*.partial 2>/dev/null || true
tar -czf /tmp/pitr-wal-backfill.tar.gz -C /tmp pitr-wal-backfill
ls -la /tmp/pitr-wal-backfill.tar.gz
echo "FILES=$(ls "$OUT" | wc -l)"
