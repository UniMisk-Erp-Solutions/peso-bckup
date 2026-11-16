#!/usr/bin/env bash
set -euo pipefail
BATCH="${1:-PITR_WAL_BATCH_1790575046}"
export SUDO_PASSWORD="${SUDO_PASSWORD:?}"
run_sudo() { echo "$SUDO_PASSWORD" | sudo -S "$@"; }
C=pitr-expense-recovery
CSV="/tmp/pitr-restore-to-46-${BATCH}.csv"

run_sudo docker exec "$C" psql -U postgres -tAc "SELECT count(1) FROM public.expenses WHERE purpose='$BATCH';" | tr -d ' \r\n' | grep -qx 500
run_sudo docker exec "$C" psql -U postgres -d postgres -c \
  "\\copy (SELECT * FROM public.expenses WHERE purpose='$BATCH') TO STDOUT WITH (FORMAT csv, HEADER true)" > "$CSV"
lines=$(wc -l < "$CSV" | tr -d ' ')
echo "CSV_LINES=$lines FILE=$CSV"
[[ "$lines" -ge 501 ]] || exit 1
