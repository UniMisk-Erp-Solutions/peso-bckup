-- Rollback for 20260820210000_form_template_option_summary_and_create.sql
DROP FUNCTION IF EXISTS public.get_form_template_editor_summary(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_form_template_parent_option(uuid, uuid, text);
NOTIFY pgrst, 'reload schema';
