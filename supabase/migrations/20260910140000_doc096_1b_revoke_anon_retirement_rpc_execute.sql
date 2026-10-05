-- DOC-096 Milestone 1B security hotfix: revoke anon EXECUTE on the 6
-- template/option retirement RPCs. Same root cause as the earlier Milestone
-- 1A/1D/1C hotfix (20260909130000_doc096_revoke_anon_mutating_rpc_execute.sql):
-- these functions were shipped directly to Production without ever going
-- through a committed main migration, so they inherited this database's
-- ALTER DEFAULT PRIVILEGES rule that grants EXECUTE on every new public
-- function directly to anon and authenticated (not via PUBLIC).
--
-- Confirmed by reading all 6 live function bodies during the Milestone 1B
-- recovery review: every one independently enforces auth.uid() IS NOT NULL
-- and an org-scoped admin-role membership check, so an anon caller cannot
-- bypass authorization today -- this closes a defense-in-depth gap, not an
-- active exploit. authenticated keeps EXECUTE: all 6 are legitimate
-- user-facing RPCs meant to be called by logged-in application users.
--
-- Pure ACL change. No function bodies are touched, no rows are read or
-- written.

REVOKE EXECUTE ON FUNCTION public.retire_form_field_template_undoable(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.undo_form_field_template_retirement(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.restore_form_field_template(uuid, uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.retire_form_field_option_undoable(uuid, uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.undo_form_field_option_retirement(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.restore_form_field_option(uuid, uuid, text) FROM anon;
