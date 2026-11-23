#!/usr/bin/env bash
BATCH=PITR_WAL_BATCH_1790405242
run_sudo() { echo "${SUDO_PASSWORD:-qwertyui}" | sudo -S "$@"; }
run_sudo docker ps -a --filter name=pitr-expense
run_sudo docker logs pitr-expense-recovery 2>&1 | tail -8
run_sudo docker exec pitr-expense-recovery pg_isready -U postgres 2>&1 || true
run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>&1 || true
run_sudo docker exec pitr-expense-recovery psql -U postgres -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH';" 2>&1 || true
