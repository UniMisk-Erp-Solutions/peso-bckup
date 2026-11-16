#!/usr/bin/env bash
ID=8c126b0a-22c3-41cd-983a-f82376145aea
echo "=== LIVE .46 primary ==="
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM public.expenses WHERE id='$ID';"
echo "=== RECOVERED .68 PITR :55432 ==="
sudo docker exec pitr-expense-recovery psql -U postgres -d postgres -c \
  "SELECT id, title, total_amount, created_at FROM public.expenses WHERE id='$ID';"
