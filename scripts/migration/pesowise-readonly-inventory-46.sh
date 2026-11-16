#!/usr/bin/env bash
# Read-only PesoWise production inventory on .46 — kar0ro1k6jiyfxzzw7acnsza ONLY.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
PREFIX=kar0ro1k6jiyfxzzw7acnsza

echo "PESOWISE_SERVICE_ID=$PREFIX"
echo "=== containers (filter name=$PREFIX) ==="
docker ps -a --filter "name=$PREFIX" --format '{{.Names}}|{{.Image}}|{{.Status}}'

echo "=== postgres version ==="
docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT current_setting('server_version');"

echo "=== row counts (public + auth) ==="
for q in \
  "SELECT count(*) FROM auth.users" \
  "SELECT count(*) FROM public.profiles" \
  "SELECT count(*) FROM public.expenses" \
  "SELECT count(*) FROM public.expense_attachments" \
  "SELECT count(*) FROM public.notifications" \
  "SELECT count(*) FROM public.audit_logs" \
  "SELECT count(*) FROM storage.objects WHERE bucket_id IN (SELECT id FROM storage.buckets LIMIT 20)" \
  ; do
  c=$(docker exec "$DB" psql -U supabase_admin -d postgres -tAc "$q" 2>/dev/null || echo ERR)
  echo "$q => $c"
done

echo "=== financial sanity (no PII) ==="
docker exec "$DB" psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*), coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses;" 2>/dev/null || echo expenses_ERR

echo "INVENTORY_DONE"
