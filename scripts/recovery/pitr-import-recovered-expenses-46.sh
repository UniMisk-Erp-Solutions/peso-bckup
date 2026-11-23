#!/usr/bin/env bash
set -euo pipefail
BATCH="${1:-PITR_WAL_BATCH_1790575046}"
PROD_DB="${PROD_DB:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
CSV="${2:-/tmp/pitr-restore-to-46-${BATCH}.csv}"
[[ -f "$CSV" ]] || { echo "FAIL: missing $CSV"; exit 1; }

LIVE=$(docker exec "$PROD_DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(1) FROM public.expenses WHERE purpose='$BATCH';" | tr -d ' \r\n')
echo "Live before restore: $LIVE"

docker exec -i "$PROD_DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "\\copy public.expenses FROM STDIN WITH (FORMAT csv, HEADER true)" < "$CSV"

AFTER=$(docker exec "$PROD_DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(1) FROM public.expenses WHERE purpose='$BATCH';" | tr -d ' \r\n')
echo "Live after restore: $AFTER"
[[ "$AFTER" == "500" ]] && echo "RESTORE_TO_46=PASS" || { echo "RESTORE_TO_46=FAIL"; exit 1; }
