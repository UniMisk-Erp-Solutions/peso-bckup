#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
MANIFEST="${1:-/tmp/pitr-expense-demo/manifest.json}"

run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }

BATCH_ID=$(sed -n 's/.*"batch_id":"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
EXPECTED=$(sed -n 's/.*"expected_count":\([0-9]*\).*/\1/p' "$MANIFEST" | head -1)
TARGET_TIME=$(sed -n 's/.*"recovery_target_time":"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
[[ -n "$BATCH_ID" && -n "$TARGET_TIME" && -n "$EXPECTED" ]] || { echo "FAIL: bad manifest"; exit 1; }

BASE_ROOT=/var/lib/pesowise-pitr-backup/base
WAL_DIR=/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-config/_data/pitr-wal
LATEST=$(run_sudo find "$BASE_ROOT" -path '*/pitr-base-pack-*/SUCCESS' -printf '%h\n' 2>/dev/null | sort | tail -1)
[[ -z "$LATEST" ]] && LATEST=$(run_sudo find "$BASE_ROOT" -name SUCCESS -printf '%h\n' 2>/dev/null | sort | tail -1)
[[ -n "$LATEST" ]] || { echo "FAIL: no base backup"; exit 1; }
if run_sudo test -f "$LATEST/data/PG_VERSION"; then
  BASE_DATA="$LATEST/data"
elif run_sudo test -f "$LATEST/PG_VERSION"; then
  BASE_DATA="$LATEST"
else
  echo "FAIL: invalid base under $LATEST"
  exit 1
fi

LAB=/var/lib/pesowise-pitr-recovery-demo
run_sudo rm -rf "$LAB"
run_sudo mkdir -p "$LAB"

SCRIPT=/tmp/ha/restore-pitr.sh
[[ -f "$SCRIPT" ]] || SCRIPT="$(dirname "$0")/restore-pitr.sh"
run_sudo bash "$SCRIPT" \
  --base-backup "$BASE_DATA" \
  --wal-dir "$WAL_DIR" \
  --target-time "$TARGET_TIME" \
  --target-dir "$LAB" \
  --execute

run_sudo chown -R 70:70 "$LAB/pgdata"

run_sudo docker rm -f pitr-expense-recovery 2>/dev/null || true
run_sudo docker run -d --name pitr-expense-recovery \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$WAL_DIR:/pitr-wal:ro" \
  -v "$LAB/pgdata:/var/lib/postgresql/data" \
  -p 55432:5432 \
  supabase/postgres:15.8.1.085

echo "Waiting for PITR recovery on :55432 ..."
for i in $(seq 1 600); do
  if run_sudo docker exec pitr-expense-recovery pg_isready -U postgres -q 2>/dev/null; then
    rec=$(run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo t)
    [[ "$rec" == "f" ]] && break
  fi
  sleep 2
done

RCNT=$(run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH_ID';" 2>/dev/null || echo 0)
SUM=$(run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc \
  "SELECT coalesce(sum(total_amount),0) FROM public.expenses WHERE purpose='$BATCH_ID';" 2>/dev/null || echo 0)

REPORT="$LAB/REPORT.txt"
{
  echo "PITR 500-expense demo (.68 WAL)"
  echo "batch_id=$BATCH_ID"
  echo "expected_count=$EXPECTED"
  echo "recovered_count=$RCNT"
  echo "recovered_sum_amount=$SUM"
  echo "recovery_target_time=$TARGET_TIME"
  if [[ "$RCNT" == "$EXPECTED" ]]; then echo "FINAL=PASS"; else echo "FINAL=FAIL"; fi
} | run_sudo tee "$REPORT"

run_sudo cat "$REPORT"
[[ "$RCNT" == "$EXPECTED" ]] || exit 1
