-- Rollback for 20260820220000_form_template_runtime_option_configuration.sql
DROP FUNCTION IF EXISTS public.get_runtime_form_option_configuration(uuid, uuid, text);
NOTIFY pgrst, 'reload schema';
