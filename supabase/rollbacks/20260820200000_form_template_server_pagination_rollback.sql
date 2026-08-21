-- Rollback for 20260820200000_form_template_server_pagination.sql
DROP FUNCTION IF EXISTS public.search_form_template_parent_options(uuid, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.get_form_template_parent_option_configuration(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.save_parent_option_branch_configuration_atomically(uuid, uuid, text, text, jsonb, text, text);
NOTIFY pgrst, 'reload schema';
