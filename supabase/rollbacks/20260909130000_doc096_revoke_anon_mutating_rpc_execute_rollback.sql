-- Rollback for 20260909130000_doc096_revoke_anon_mutating_rpc_execute.sql
-- Re-grants anon EXECUTE on the 11 DOC-096 undo/archive/deactivate RPCs,
-- restoring the pre-hardening state. NOT recommended -- this re-opens the
-- defense-in-depth gap the forward migration closed. Provided only for
-- symmetry/emergency use.

GRANT EXECUTE ON FUNCTION public.archive_expense_category_undoable(uuid, uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.undo_expense_category_archive(uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.archive_location_undoable(uuid, uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.undo_location_archive(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.restore_location(uuid, uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.archive_team_undoable(uuid, uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.undo_team_archive(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.restore_team(uuid, uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.deactivate_organization_member_undoable(uuid, uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.undo_organization_member_deactivation(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.reactivate_organization_member(uuid, uuid) TO anon;

NOTIFY pgrst, 'reload schema';
