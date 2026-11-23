#!/usr/bin/env bash
# Phase 4: PesoWise-only data inventory (read-only). kar0ro1k6jiyfxzzw7acnsza DB only.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza

run() {
  docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 "$@"
}

echo "=== public table row counts (non-empty or app-relevant) ==="
run -tAc "
SELECT relname, n_live_tup::bigint
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup DESC NULLS LAST, relname;
"

echo "=== auth.users / identities ==="
run -tAc "SELECT count(*) AS auth_users FROM auth.users;"
run -tAc "SELECT count(*) AS identities FROM auth.identities;"

echo "=== user_roles ==="
run -tAc "SELECT count(*) FROM public.user_roles;" 2>/dev/null || echo "user_roles: UNKNOWN/missing"

echo "=== money / balances ==="
for t in money_assignments money_return_requests profile_balances balance_ledger_entries balance_transfer_offers; do
  c=$(run -tAc "SELECT count(*) FROM public.${t};" 2>/dev/null || echo ERR)
  echo "${t}=${c}"
done

echo "=== attachments (table discovery) ==="
run -tAc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ILIKE '%attach%' ORDER BY 1;"
for t in expense_attachments attachments expense_receipts expense_attachment_files; do
  c=$(run -tAc "SELECT count(*) FROM public.${t};" 2>/dev/null || echo skip)
  echo "try_${t}=${c}"
done

echo "=== storage ==="
run -tAc "SELECT id, name, public FROM storage.buckets ORDER BY name;"
run -tAc "SELECT count(*), coalesce(sum((metadata->>'size')::bigint),0) FROM storage.objects;"
run -tAc "SELECT bucket_id, count(*) FROM storage.objects GROUP BY 1 ORDER BY 2 DESC LIMIT 15;"

echo "=== RLS enabled public tables (count) ==="
run -tAc "SELECT count(*) FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=t.schemaname WHERE t.schemaname='public' AND c.relrowsecurity;"

echo "=== financial aggregates ==="
run -tAc "SELECT status, count(*) FROM public.expenses GROUP BY status ORDER BY count DESC;"
run -tAc "SELECT coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses WHERE status IN ('approved','paid');" 2>/dev/null || true

echo "INVENTORY_PHASE4_DONE"
