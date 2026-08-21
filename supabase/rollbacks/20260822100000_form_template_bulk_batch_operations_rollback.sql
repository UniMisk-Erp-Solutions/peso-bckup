-- Rollback for 20260822100000_form_template_bulk_batch_operations.sql
DROP FUNCTION IF EXISTS public.get_form_template_parent_option_configurations_batch(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS public.save_form_template_parent_option_configurations_batch_atomically(uuid, uuid, text[], jsonb, text, text);
DROP FUNCTION IF EXISTS public.rename_form_template_parent_option(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.delete_form_template_parent_option(uuid, uuid, text);
NOTIFY pgrst, 'reload schema';
