#!/usr/bin/env bash
MAN="${1:-/tmp/pitr-expense-demo/manifest.json}"
BATCH=$(sed -n 's/.*"batch_id":"\([^"]*\)".*/\1/p' "$MAN" | head -1)
run_sudo() { echo "${SUDO_PASSWORD:-qwertyui}" | sudo -S "$@"; }
run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc \
  "SELECT count(*), round(sum(total_amount)::numeric,2), min(total_amount), max(total_amount) FROM public.expenses WHERE purpose='$BATCH';"
