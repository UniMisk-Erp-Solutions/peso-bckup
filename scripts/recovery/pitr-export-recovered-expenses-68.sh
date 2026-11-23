#!/usr/bin/env bash
# Copy expenses from .68 PITR lab (:55432 container) back into .46 production.
set -euo pipefail
BATCH="${1:-PITR_WAL_BATCH_1790575046}"
RECOVERY_C="${PITR_RECOVERY_CONTAINER:-pitr-expense-recovery}"
PROD_DB="${PROD_DB:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
DUMP="/tmp/pitr-restore-to-46-${BATCH}.sql"
SUDO_PASS="${SUDO_PASSWORD:-}"

run_sudo() {
  if [[ -n "$SUDO_PASS" ]]; then echo "$SUDO_PASS" | sudo -S "$@"; else sudo "$@"; fi
}

echo "Export from .68 recovery container ($RECOVERY_C) batch=$BATCH"
run_sudo docker exec "$RECOVERY_C" pg_isready -U postgres -q
REC_CNT=$(run_sudo docker exec "$RECOVERY_C" psql -U postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH';" | tr -d ' \r\n')
[[ "$REC_CNT" == "500" ]] || { echo "FAIL: recovery has $REC_CNT rows, expected 500"; exit 1; }

run_sudo docker exec "$RECOVERY_C" pg_dump -U postgres -d postgres \
  --data-only --inserts \
  -t public.expenses \
  --where "purpose = '$BATCH'" >"$DUMP"

lines=$(grep -c '^INSERT INTO public.expenses' "$DUMP" || true)
[[ "${lines:-0}" -ge 500 ]] || { echo "FAIL: dump has $lines INSERTs"; exit 1; }
echo "DUMP_OK inserts=$lines path=$DUMP"
