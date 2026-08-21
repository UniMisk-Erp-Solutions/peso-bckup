-- Rollback for 20260821110000_form_template_orphan_inspector_and_runtime_search.sql
DROP FUNCTION IF EXISTS public.get_form_template_legacy_orphan_groups(uuid, uuid);
DROP FUNCTION IF EXISTS public.search_runtime_form_template_parent_options_v1(uuid, uuid, text, integer);
DROP FUNCTION IF EXISTS public.get_my_recent_form_template_options_v1(uuid, uuid, integer);
NOTIFY pgrst, 'reload schema';
