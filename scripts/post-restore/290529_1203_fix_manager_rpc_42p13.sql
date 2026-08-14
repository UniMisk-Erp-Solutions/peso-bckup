-- 290529_1203_fix_manager_rpc_42p13.sql
-- Run this in SQL Editor if Section 2 failed with:
--   cannot change name of input parameter "p_org_id"
-- Then re-run manual-section-2-hierarchy-migrations.sql from the start
-- (idempotent migrations) OR continue from migration 17 if you prefer.

DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);
DROP FUNCTION IF EXISTS public.list_manager_level2_expenses(uuid);
DROP FUNCTION IF EXISTS public.repair_expense_for_manager_review(uuid);
DROP FUNCTION IF EXISTS public.manager_expense_visible_to_user(public.expenses, uuid);
DROP FUNCTION IF EXISTS public.manager_expense_visible_to_user(uuid, uuid);

SELECT 'Manager RPC signatures dropped — re-run Section 2 from migration 18, or full Section 2' AS next_step;
