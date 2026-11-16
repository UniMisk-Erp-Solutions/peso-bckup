#!/usr/bin/env bash
echo qwertyui | sudo -S docker exec pitr-expense-recovery psql -U postgres -d postgres -c \
  "SELECT id, title, total_amount, created_at FROM public.expenses WHERE title LIKE 'PITR_WAL_DEMO_%';"
