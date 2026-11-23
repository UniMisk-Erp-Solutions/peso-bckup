#!/usr/bin/env bash
# Compare source Supabase DB vs migration v2 (read-only on source).
set -euo pipefail
SRC=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TGT=pesowise-postgres-migration-v2

q_src() { docker exec "$SRC" psql -U supabase_admin -d postgres -tAc "$1"; }
q_tgt() { docker exec "$TGT" psql -U pesowise_migration -d pesowise -tAc "$1"; }

echo "ENTITY|SOURCE|TARGET"
for pair in \
  "auth.users|SELECT count(*) FROM auth.users" \
  "public.profiles|SELECT count(*) FROM public.profiles" \
  "public.expenses|SELECT count(*) FROM public.expenses" \
  "public.attachments|SELECT count(*) FROM public.attachments" \
  "public.notifications|SELECT count(*) FROM public.notifications" \
  "public.audit_logs|SELECT count(*) FROM public.audit_logs" \
  "expense_sum|SELECT coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses" \
  ; do
  name="${pair%%|*}"
  sql="${pair#*|}"
  s=$(q_src "$sql" 2>/dev/null || echo ERR)
  t=$(q_tgt "$sql" 2>/dev/null || echo ERR)
  match=NO
  [[ "$s" == "$t" ]] && match=YES
  echo "${name}|${s}|${t}|${match}"
done
echo "COMPARE_DONE"
