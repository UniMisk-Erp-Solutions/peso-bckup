#!/usr/bin/env bash
# Full read-only integrity compare: source Supabase DB vs migration v2.
set -euo pipefail
SRC=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TGT=pesowise-postgres-migration-v2
OUT=/tmp/pesowise-migration-backup/integrity-full-$(date -u +%Y%m%dT%H%M%SZ).txt

q_src() { docker exec "$SRC" psql -U supabase_admin -d postgres -tAc "$1" 2>/dev/null; }
q_tgt() { docker exec "$TGT" psql -U pesowise_migration -d pesowise -tAc "$1" 2>/dev/null; }

{
  echo "PESOWISE_INTEGRITY_FULL"
  echo "source=$SRC target=$TGT"
  echo ""
  echo "=== PUBLIC TABLE ROW COUNTS ==="
  echo "table|source|target|match"
  tables=$(q_src "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;")
  mismatches=0
  while IFS= read -r t; do
    [[ -z "$t" ]] && continue
    s=$(q_src "SELECT count(*)::bigint FROM public.\"${t}\";")
    tg=$(q_tgt "SELECT count(*)::bigint FROM public.\"${t}\";")
    m=YES
    [[ "$s" != "$tg" ]] && m=NO && mismatches=$((mismatches + 1))
    echo "${t}|${s}|${tg}|${m}"
  done <<< "$tables"
  echo "public_table_mismatches=$mismatches"
  echo ""
  echo "=== AUTH / STORAGE ==="
  while IFS='|' read -r name q; do
    [[ -z "$name" ]] && continue
    s=$(q_src "$q")
    tg=$(q_tgt "$q")
    m=YES; [[ "$s" != "$tg" ]] && m=NO
    echo "${name}|${s}|${tg}|${m}"
  done <<'EOF'
auth.users|SELECT count(*) FROM auth.users
auth.identities|SELECT count(*) FROM auth.identities
auth.sessions|SELECT count(*) FROM auth.sessions
storage.buckets|SELECT count(*) FROM storage.buckets
storage.objects|SELECT count(*) FROM storage.objects
storage.bytes|SELECT coalesce(sum((metadata->>'size')::bigint),0) FROM storage.objects
EOF
  echo ""
  echo "=== FINANCIAL CHECKSUMS ==="
  while IFS='|' read -r name q; do
    [[ -z "$name" ]] && continue
    s=$(q_src "$q")
    tg=$(q_tgt "$q")
    m=YES; [[ "$s" != "$tg" ]] && m=NO
    echo "${name}|${s}|${tg}|${m}"
  done <<'EOF'
expenses.count|SELECT count(*) FROM public.expenses
expenses.sum_total|SELECT coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses
expenses.sum_approved|SELECT coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses WHERE status IN ('approved','paid')
money_assignments.sum|SELECT coalesce(round(sum(amount)::numeric,2),0) FROM public.money_assignments
money_return_requests.count|SELECT count(*) FROM public.money_return_requests
user_roles.count|SELECT count(*) FROM public.user_roles
EOF
  echo ""
  echo "=== SEQUENCE MAX (public, sample) ==="
  seqs=$(q_src "SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename LIMIT 30;")
  while IFS= read -r seq; do
    [[ -z "$seq" ]] && continue
    s=$(q_src "SELECT last_value FROM public.\"${seq}\";")
    tg=$(q_tgt "SELECT last_value FROM public.\"${seq}\";")
    m=YES; [[ "$s" != "$tg" ]] && m=NO
    echo "seq.${seq}|${s}|${tg}|${m}"
  done <<< "$seqs"
  echo ""
  echo "=== FK orphan spot-check (expenses.submitter_id -> profiles) ==="
  s=$(q_src "SELECT count(*) FROM public.expenses e LEFT JOIN public.profiles p ON p.id=e.submitter_id WHERE p.id IS NULL AND e.submitter_id IS NOT NULL;")
  tg=$(q_tgt "SELECT count(*) FROM public.expenses e LEFT JOIN public.profiles p ON p.id=e.submitter_id WHERE p.id IS NULL AND e.submitter_id IS NOT NULL;")
  echo "orphan_expense_submitter|${s}|${tg}|$( [[ "$s" == "$tg" ]] && echo YES || echo NO )"
  echo "INTEGRITY_DONE"
} | tee "$OUT"
echo "REPORT=$OUT"
