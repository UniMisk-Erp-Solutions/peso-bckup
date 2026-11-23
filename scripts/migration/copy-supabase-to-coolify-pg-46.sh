#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SRC=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TGT=mqgd6kfhdrcbpa2c2bvyjwvc
PG_USER=pesowise_app
PG_DB=pesowise
DUMP=/tmp/pesowise-migration-backup/supabase-to-coolify-${STAMP}.dump

echo "COPY_START src=$SRC tgt=$TGT"
docker exec "$SRC" pg_dump -U supabase_admin -d postgres -Fc -f /tmp/pesowise-coolify.dump
docker cp "$SRC:/tmp/pesowise-coolify.dump" "$DUMP"
docker exec "$SRC" rm -f /tmp/pesowise-coolify.dump
sha256sum "$DUMP" > "${DUMP}.sha256"

docker cp "$DUMP" "$TGT:/tmp/pesowise.restore.dump"
docker exec "$TGT" pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner --role="$PG_USER" -j 4 /tmp/pesowise.restore.dump || true
docker exec "$TGT" rm -f /tmp/pesowise.restore.dump

for pair in \
  "auth.users|SELECT count(*) FROM auth.users" \
  "public.expenses|SELECT count(*) FROM public.expenses" \
  "expense_sum|SELECT coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses"; do
  name="${pair%%|*}"
  sql="${pair#*|}"
  s=$(docker exec "$SRC" psql -U supabase_admin -d postgres -tAc "$sql")
  t=$(docker exec "$TGT" psql -U "$PG_USER" -d "$PG_DB" -tAc "$sql")
  echo "VERIFY|${name}|source=${s}|target=${t}|match=$([[ "$s" == "$t" ]] && echo YES || echo NO)"
done
echo "COPY_DONE dump=$DUMP"
