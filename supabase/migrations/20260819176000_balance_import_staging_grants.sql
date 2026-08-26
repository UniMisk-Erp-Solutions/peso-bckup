-- DOC-099 — separate client-staged input from server-computed state on the
-- import staging tables, found during an independent repo scan.
--
-- balance_import_batches / balance_import_rows currently grant table-level
-- SELECT/INSERT/UPDATE/DELETE to `authenticated`, gated only by the
-- row-level "Admins manage org import batches/rows" RLS policy. RLS is
-- row-scoped, not column-scoped: an org admin's own PostgREST session can
-- currently UPDATE server-owned fields directly -- status, applied_at,
-- applied_by, reversed_at, reversed_by, row/valid/invalid counts,
-- total_delta on batches; matched_user_id, snapshots, validation_status/
-- code/message, ledger_entry_id on rows -- none of which should ever be
-- client-writable. That weakens the financial audit trail: those columns
-- exist specifically so an admin (or anyone with their session) can't claim
-- a batch was "applied" or a row "matched" some user without the
-- SECURITY DEFINER RPCs actually having done that work.
--
-- Fixed with Postgres column-level privileges, composing with the existing
-- row-level RLS policy (both must pass): the client keeps exactly the
-- columns it legitimately stages, nothing more. The validate/apply/reverse
-- RPCs are unaffected -- SECURITY DEFINER functions run as the function
-- owner, not the calling role, so column grants on `authenticated` never
-- constrain them.

-- ---------------------------------------------------------------------------
-- balance_import_batches
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON public.balance_import_batches FROM authenticated;

GRANT INSERT (organization_id, mode, original_filename, note, created_by)
  ON public.balance_import_batches TO authenticated;

GRANT UPDATE (source_storage_path, source_sha256, mapping_profile_id, default_effective_date, note)
  ON public.balance_import_batches TO authenticated;

-- ---------------------------------------------------------------------------
-- balance_import_rows
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON public.balance_import_rows FROM authenticated;

GRANT INSERT (batch_id, row_number, raw_employee_id, normalized_employee_id,
              raw_email, normalized_email, input_amount, effective_date, note)
  ON public.balance_import_rows TO authenticated;

-- No UPDATE grant at all: every row field a client could legitimately
-- change after staging (raw identity/amount/date/note) is meant to be
-- immutable once inserted -- a correction means deleting the draft row (RLS
-- still allows DELETE) and re-inserting, not editing it in place. Server-
-- owned fields (matched_user_id, current_balance_snapshot,
-- calculated_new_balance, validation_status/code/message, ledger_entry_id)
-- are written only by balance_validate_import_v1 / balance_apply_import_v1.

NOTIFY pgrst, 'reload schema';
