-- Rollback for 20260822130000_fix_batch_save_function_name_truncation.sql
DROP FUNCTION IF EXISTS public.save_form_template_parent_options_batch_atomically(uuid, uuid, text[], jsonb, text, text);
NOTIFY pgrst, 'reload schema';
