-- Rollback for 20260822150000_revoke_anon_from_admin_form_template_rpcs.sql
-- Re-grants anon EXECUTE on these functions, restoring the pre-hardening
-- state. NOT recommended -- this re-opens the defense-in-depth gap the
-- forward migration closed. Provided only for symmetry/emergency use.
GRANT EXECUTE ON FUNCTION public.create_form_template_parent_option(uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.delete_form_template_parent_option(uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_form_template_editor_summary(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_form_template_legacy_orphan_groups(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_form_template_parent_option_configuration(uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_form_template_parent_option_configurations_batch(uuid, uuid, text[]) TO anon;
GRANT EXECUTE ON FUNCTION public.rename_form_template_parent_option(uuid, uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.save_form_template_parent_options_batch_atomically(uuid, uuid, text[], jsonb, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.search_form_template_parent_options(uuid, uuid, text, integer, integer, boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.save_parent_option_branch_configuration_atomically(uuid, uuid, text, text, jsonb, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.save_option_branch_configuration_atomically(uuid, uuid, timestamp with time zone, jsonb, jsonb, text, text) TO anon;
NOTIFY pgrst, 'reload schema';
