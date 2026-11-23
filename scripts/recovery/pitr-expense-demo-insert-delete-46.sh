#!/usr/bin/env bash
# Insert 500 expenses (random amounts), record PITR target time, delete all. Run on .46.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
OUT=/tmp/pitr-expense-demo
COUNT="${PITR_DEMO_COUNT:-500}"
mkdir -p "$OUT"

BATCH_ID="PITR_WAL_BATCH_$(date +%s)"
MARKER="$BATCH_ID"

docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.expenses WHERE purpose LIKE 'PITR_WAL_BATCH_%';" 2>/dev/null || true

USER_ID=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT id FROM auth.users ORDER BY created_at NULLS LAST LIMIT 1;" 2>/dev/null | tr -d ' \r\n')
[[ -z "$USER_ID" ]] && USER_ID=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT user_id FROM public.expenses LIMIT 1;" | tr -d ' \r\n')
[[ -n "$USER_ID" ]] || { echo "FAIL: no user_id"; exit 1; }

HAS_ORG=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='expenses' AND column_name='organization_id';")

if [[ "$HAS_ORG" == "1" ]]; then
  ORG_ID=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
    "SELECT organization_id FROM public.expenses WHERE organization_id IS NOT NULL LIMIT 1;" | tr -d ' \r\n')
  docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "
INSERT INTO public.expenses (user_id, organization_id, title, trip_start, trip_end, destination, purpose, total_amount, status)
SELECT
  '$USER_ID'::uuid,
  '$ORG_ID'::uuid,
  '${BATCH_ID}_' || g,
  CURRENT_DATE,
  CURRENT_DATE,
  'PITR Demo',
  '$BATCH_ID',
  round((random() * 4990 + 10)::numeric, 2),
  'draft'::expense_status
FROM generate_series(1, $COUNT) g;"
else
  docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c "
INSERT INTO public.expenses (user_id, title, trip_start, trip_end, destination, purpose, total_amount, status)
SELECT
  '$USER_ID'::uuid,
  '${BATCH_ID}_' || g,
  CURRENT_DATE,
  CURRENT_DATE,
  'PITR Demo',
  '$BATCH_ID',
  round((random() * 4990 + 10)::numeric, 2),
  'draft'::expense_status
FROM generate_series(1, $COUNT) g;"
fi

BEFORE=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH_ID';")
[[ "$BEFORE" == "$COUNT" ]] || { echo "FAIL: inserted $BEFORE expected $COUNT"; exit 1; }

docker exec "$DB" psql -U supabase_admin -d postgres -c "SELECT pg_switch_wal(); CHECKPOINT;"

T_PRE=$(docker exec "$DB" psql -U supabase_admin -d postgres -Atqc \
  "SELECT to_char(max(created_at) + interval '2 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') || '+00'
   FROM public.expenses WHERE purpose='$BATCH_ID';" | tr -d ' \r\n')

sleep 2

docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.expenses WHERE purpose='$BATCH_ID';"
docker exec "$DB" psql -U supabase_admin -d postgres -c "SELECT pg_switch_wal(); CHECKPOINT;"

GONE=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE purpose='$BATCH_ID';")

printf '{"batch_id":"%s","marker":"%s","expected_count":%s,"recovery_target_time":"%s","live_after_delete":%s}\n' \
  "$BATCH_ID" "$MARKER" "$COUNT" "$T_PRE" "$GONE" >"$OUT/manifest.json"

echo "BATCH_ID=$BATCH_ID"
echo "INSERTED_COUNT=$BEFORE"
echo "RECOVERY_TARGET_TIME=$T_PRE"
echo "LIVE_COUNT_AFTER_DELETE=$GONE"
echo "MANIFEST=$OUT/manifest.json"
