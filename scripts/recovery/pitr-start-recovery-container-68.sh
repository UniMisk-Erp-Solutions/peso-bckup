#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
MAN=/tmp/pitr-expense-demo/manifest.json
BATCH=$(sed -n 's/.*"batch_id":"\([^"]*\)".*/\1/p' "$MAN" | head -1)
EXPECTED=$(sed -n 's/.*"expected_count":\([0-9]*\).*/\1/p' "$MAN" | head -1)
WAL_DIR=/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-config/_data/pitr-wal
LAB=/var/lib/pesowise-pitr-recovery-demo
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }

run_sudo docker rm -f pitr-expense-recovery 2>/dev/null || true
run_sudo docker run -d --name pitr-expense-recovery \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$WAL_DIR:/pitr-wal:ro" \
  -v "$LAB/pgdata:/var/lib/postgresql/data" \
  -p 55432:5432 \
  supabase/postgres:15.8.1.085

for i in $(seq 1 120); do
  run_sudo docker exec pitr-expense-recovery pg_isready -U postgres -q 2>/dev/null || { sleep 2; continue; }
  rec=$(run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo t)
  [[ "$rec" == "f" ]] && break
  sleep 2
done

RCNT=$(run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH';")
SUM=$(run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc \
  "SELECT round(sum(total_amount)::numeric,2) FROM public.expenses WHERE purpose='$BATCH';")

echo "recovered_count=$RCNT expected=$EXPECTED sum=$SUM"
[[ "$RCNT" == "$EXPECTED" ]] && echo FINAL=PASS || echo FINAL=FAIL
