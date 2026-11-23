#!/usr/bin/env bash
set -euo pipefail
source /tmp/pesowise-migration-v2/.env
BASE="${1:?base dir}"
WAL="${2:?wal dir}"
TEST=pesowise-postgres-pitr-wal-test
TARGET_LSN=""
if [[ -f "$WAL/recovery_target_lsn.txt" ]]; then
  TARGET_LSN=$(tr -d '[:space:]' < "$WAL/recovery_target_lsn.txt")
fi

if [[ -n "$TARGET_LSN" ]]; then
  docker run --rm -v "$BASE:/d" alpine sh -c "cat >> /d/postgresql.auto.conf <<INNER
restore_command = 'cp /wal_archive/%f %p'
recovery_target_lsn = '${TARGET_LSN}'
recovery_target_inclusive = off
recovery_target_action = 'promote'
INNER"
else
  docker run --rm -v "$BASE:/d" alpine sh -c "cat >> /d/postgresql.auto.conf <<'INNER'
restore_command = 'cp /wal_archive/%f %p'
recovery_target_name = 'pitr_drill_before_b'
recovery_target_action = 'promote'
INNER"
fi
touch "$BASE/recovery.signal"
rm -f "$BASE/standby.signal" 2>/dev/null || true
chmod -R a+rX "$WAL" 2>/dev/null || true
find "$WAL" -type f -exec chmod a+r {} \; 2>/dev/null || true
docker run --rm -v "$BASE:/d" alpine sh -c 'chown -R 999:999 /d'
docker rm -f "$TEST" 2>/dev/null || true
docker run -d --name "$TEST" \
  -v "$BASE:/var/lib/postgresql/data" \
  -v "$WAL:/wal_archive:ro" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_USER=pesowise_migration \
  -e POSTGRES_DB=pesowise \
  -p 127.0.0.1:15434:5432 \
  postgres:15-alpine

for i in $(seq 1 90); do
  if docker exec "$TEST" pg_isready -U pesowise_migration -d pesowise 2>/dev/null; then
    A=$(docker exec "$TEST" psql -U pesowise_migration -d pesowise -tAc "SELECT count(*) FROM public.pitr_drill_markers WHERE phase='marker_a';")
    B=$(docker exec "$TEST" psql -U pesowise_migration -d pesowise -tAc "SELECT count(*) FROM public.pitr_drill_markers WHERE phase='marker_b';")
    EXP=$(docker exec "$TEST" psql -U pesowise_migration -d pesowise -tAc "SELECT count(*) FROM public.expenses;")
    SUM=$(docker exec "$TEST" psql -U pesowise_migration -d pesowise -tAc "SELECT round(sum(total_amount)::numeric,2) FROM public.expenses;")
    echo "marker_a=$A marker_b=$B expenses=$EXP sum_expenses=$SUM"
    if [[ "$A" -ge 1 && "$B" == "0" && "$EXP" != "" ]]; then
      echo PITR_WAL=PASS
      exit 0
    fi
    echo PITR_WAL=FAIL
    exit 1
  fi
  sleep 2
done
echo PITR_WAL=FAIL
docker logs "$TEST" 2>&1 | tail -25
exit 1
