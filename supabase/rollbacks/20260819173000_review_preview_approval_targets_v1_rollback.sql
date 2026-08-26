-- Rollback for 20260819173000_review_preview_approval_targets_v1.sql
DROP FUNCTION IF EXISTS public.review_preview_approval_targets_v1(uuid, uuid[]);
NOTIFY pgrst, 'reload schema';
