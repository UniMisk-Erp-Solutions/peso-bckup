#!/usr/bin/env bash
# Read-only integrity compare: Supabase source vs Coolify primary PostgreSQL.
set -uo pipefail
SRC=supabase-db-kar0ro1k6jiyfxzzw7acnsza
TGT=mqgd6kfhdrcbpa2c2bvyjwvc
TGT_USER=pesowise_app
TGT_DB=pesowise
OUT="${1:-/tmp/pesowise-migration-backup/coolify-integrity-$(date -u +%Y%m%dT%H%M%SZ).txt}"

q_src() { docker exec "$SRC" psql -U supabase_admin -d postgres -tAc "$1" 2>/dev/null; }
q_tgt() { docker exec "$TGT" psql -U "$TGT_USER" -d "$TGT_DB" -tAc "$1" 2>/dev/null; }

{
  echo "COOLIFY_PRIMARY_INTEGRITY"
  echo "source=$SRC target=$TGT"
  echo ""
  echo "=== PUBLIC TABLE ROW COUNTS ==="
  echo "table|source|target|match"
  mismatches=0
  while IFS= read -r t; do
    [[ -z "$t" ]] && continue
    s=$(q_src "SELECT count(*)::bigint FROM public.\"${t}\";")
    tg=$(q_tgt "SELECT count(*)::bigint FROM public.\"${t}\";")
    m=YES
    [[ "$s" != "$tg" ]] && m=NO && mismatches=$((mismatches + 1))
    echo "${t}|${s}|${tg}|${m}"
  done <<< "$(q_src "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;")"
  echo "public_table_mismatches=$mismatches"
  echo ""
  echo "=== AUTH / STORAGE ==="
  while IFS='|' read -r name q; do
    [[ -z "$name" ]] && continue
    s=$(q_src "$q"); s=${s:-ERR}
    tg=$(q_tgt "$q"); tg=${tg:-ERR}
    m=YES; [[ "$s" != "$tg" ]] && m=NO && mismatches=$((mismatches + 1))
    echo "${name}|${s}|${tg}|${m}"
  done <<'EOF'
auth.users|SELECT count(*) FROM auth.users
auth.identities|SELECT count(*) FROM auth.identities
auth.sessions|SELECT count(*) FROM auth.sessions
auth.refresh_tokens|SELECT count(*) FROM auth.refresh_tokens
storage.buckets|SELECT count(*) FROM storage.buckets
storage.objects|SELECT count(*) FROM storage.objects
storage.bytes|SELECT coalesce(sum((metadata->>'size')::bigint),0) FROM storage.objects
EOF
  echo ""
  echo "=== FINANCIAL CHECKSUMS ==="
  while IFS='|' read -r name q; do
    [[ -z "$name" ]] && continue
    s=$(q_src "$q"); s=${s:-ERR}
    tg=$(q_tgt "$q"); tg=${tg:-ERR}
    m=YES; [[ "$s" != "$tg" ]] && m=NO && mismatches=$((mismatches + 1))
    echo "${name}|${s}|${tg}|${m}"
  done <<'EOF'
expenses.count|SELECT count(*) FROM public.expenses
expenses.sum_total|SELECT coalesce(round(sum(total_amount)::numeric,2),0) FROM public.expenses
public.profiles|SELECT count(*) FROM public.profiles
public.expense_attachments|SELECT count(*) FROM public.attachments
public.notifications|SELECT count(*) FROM public.notifications
public.audit_logs|SELECT count(*) FROM public.audit_logs
EOF
  echo "total_mismatches=$mismatches"
  echo "INTEGRITY_DONE"
} | tee "$OUT"
mismatches=$(grep '^total_mismatches=' "$OUT" | tail -1 | cut -d= -f2)
mismatches=${mismatches:-999}
echo "REPORT=$OUT"
exit $([[ "$mismatches" -eq 0 ]] && echo 0 || echo 1)
