#!/usr/bin/env bash
MAN="${1:-/tmp/pitr-expense-demo/manifest.json}"
BATCH=$(sed -n 's/.*"batch_id":"\([^"]*\)".*/\1/p' "$MAN" | head -1)
[[ -n "$BATCH" ]] || BATCH=PITR_WAL_BATCH_1790575046
run_sudo() { echo "${SUDO_PASSWORD:-qwertyui}" | sudo -S "$@"; }
echo "=== .68 recovered (55432) ==="
run_sudo docker exec pitr-expense-recovery pg_isready -U postgres 2>&1 || true
run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>&1 || true
run_sudo docker exec pitr-expense-recovery psql -U postgres -tAc "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH';" 2>&1 || true
run_sudo docker logs pitr-expense-recovery 2>&1 | grep -E 'recovery|FATAL|redo done|promoted' | tail -8
