-- DOC-096 security hotfix: revoke anon EXECUTE on the 11 Undo/Archive/Deactivate
-- RPCs. These 11 functions were shipped directly to Production (never through a
-- committed main migration) and inherited this database's ALTER DEFAULT
-- PRIVILEGES rule that grants EXECUTE on every new public function directly to
-- anon and authenticated (not via PUBLIC), the same root cause fixed for the
-- MicroLink V1 RPCs in 20260909100000_microlink_atomic_submission_v1.sql.
--
-- Every one of the 11 functions independently enforces auth.uid() IS NOT NULL
-- and an org-scoped admin-role membership check (confirmed by reading each
-- function body during the DOC-096 recovery audit), so an anon caller cannot
-- bypass authorization today -- this closes a defense-in-depth gap, not an
-- active exploit. authenticated keeps EXECUTE: all 11 are legitimate
-- user-facing RPCs meant to be called by logged-in application users.
--
-- Pure ACL change. No function bodies are touched, no rows are read or
-- written.

REVOKE EXECUTE ON FUNCTION public.archive_expense_category_undoable(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.undo_expense_category_archive(uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.archive_location_undoable(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.undo_location_archive(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.restore_location(uuid, uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.archive_team_undoable(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.undo_team_archive(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.restore_team(uuid, uuid) FROM anon;

REVOKE EXECUTE ON FUNCTION public.deactivate_organization_member_undoable(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.undo_organization_member_deactivation(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reactivate_organization_member(uuid, uuid) FROM anon;
