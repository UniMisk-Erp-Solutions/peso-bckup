#!/usr/bin/env bash
MAN="${1:-/tmp/pitr-expense-demo/manifest.json}"
ID=$(sed -n 's/.*"expense_id":"\([^"]*\)".*/\1/p' "$MAN" | head -1)
echo "expense_id=$ID"
echo qwertyui | sudo -S docker exec pitr-expense-recovery psql -U postgres -d postgres -tAc \
  "SELECT count(*), max(total_amount::text) FROM public.expenses WHERE id='$ID';"
echo qwertyui | sudo -S docker exec pitr-expense-recovery psql -U postgres -d postgres -c \
  "SELECT id, title, total_amount FROM public.expenses WHERE id='$ID';"
