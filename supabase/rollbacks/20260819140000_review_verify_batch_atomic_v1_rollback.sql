-- Rollback for supabase/migrations/20260819140000_review_verify_batch_atomic_v1.sql
--
-- Additive-only migration: this drops the single new function it created.
-- It does not touch review_advance_expense_hierarchy_tier,
-- expense_hierarchy_reviewer_can_act, or any table/column/RLS policy, so
-- there is nothing else to reverse and no data migration is involved.

DROP FUNCTION IF EXISTS public.review_verify_batch_atomic_v1(uuid, text);
