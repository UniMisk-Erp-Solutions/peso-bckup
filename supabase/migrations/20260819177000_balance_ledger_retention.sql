-- DOC-099 — balance_ledger retention audit, found during an independent
-- repo scan. New additive corrective migration.
--
-- balance_ledger.user_id was created with `REFERENCES auth.users(id) ON
-- DELETE CASCADE` (20260819160000). That means hard-deleting a user's
-- auth.users row would silently delete their ENTIRE balance ledger --
-- exactly the opposite of "immutable/permanent financial evidence".
--
-- This app does NOT purely deactivate users:
--   - organization_memberships.is_active is the normal offboarding path
--     (confirmed the established pattern used throughout every RPC in this
--     codebase, e.g. every balance RPC's "AND om.is_active = true" checks).
--   - BUT hard deletion of auth.users is structurally possible: a historical
--     one-time migration (20250128000000_delete_all_users_except_admin.sql)
--     already did `DELETE FROM auth.users` directly, and the Supabase
--     project Dashboard's own Authentication > Users > Delete action can
--     hard-delete any user at any time, entirely outside this app's own
--     code. Neither is blocked by anything in this schema today.
--
-- Fixed: balance_ledger.user_id now REFERENCES auth.users(id) ON DELETE
-- RESTRICT (the actual Postgres default when no ON DELETE clause is given
-- -- matching balance_ledger.actor_user_id, which was already correct/safe
-- with no explicit CASCADE). A user with ANY ledger history becomes
-- permanently un-hard-deletable; deactivation via
-- organization_memberships.is_active remains completely unaffected --
-- that's a different table, not touched by this FK at all.
--
-- organization_id's ON DELETE CASCADE is left as-is: deleting an entire
-- organization (not a single user) intentionally removes all of that
-- organization's data, ledger included -- a different, accepted risk
-- surface, not the "silent single-user erasure" gap this migration closes.

ALTER TABLE public.balance_ledger
  DROP CONSTRAINT IF EXISTS balance_ledger_user_id_fkey,
  ADD CONSTRAINT balance_ledger_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT balance_ledger_user_id_fkey ON public.balance_ledger IS
  'DOC-099 (rev 20260819175000). ON DELETE RESTRICT, not CASCADE: a user '
  'with any balance_ledger history cannot be hard-deleted, preserving the '
  'ledger''s immutable/permanent evidence guarantee. Offboarding uses '
  'organization_memberships.is_active, an entirely separate mechanism '
  'unaffected by this constraint.';
