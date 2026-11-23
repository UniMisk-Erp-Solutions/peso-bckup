#!/usr/bin/env bash
MAN="${1:-/tmp/pitr-expense-demo/manifest.json}"
BATCH=$(sed -n 's/.*"batch_id":"\([^"]*\)".*/\1/p' "$MAN" | head -1)
EXPECTED=$(sed -n 's/.*"expected_count":\([0-9]*\).*/\1/p' "$MAN" | head -1)
echo "=== LIVE .46 (batch $BATCH) ==="
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH';"
echo "=== RECOVERED .68 :55432 ==="
SUDO_PASS="${SUDO_PASSWORD:-qwertyui}"
echo "$SUDO_PASS" | sudo -S docker exec pitr-expense-recovery psql -U postgres -d postgres -tAc \
  "SELECT count(*), round(sum(total_amount)::numeric,2) FROM public.expenses WHERE purpose='$BATCH';"
echo "expected=$EXPECTED"
