-- DOC-099 — financial path closure pass, corrective migration #5.
--
-- 20260819176000 removed direct client UPDATE of server-owned import
-- columns but deliberately left table-level DELETE granted to
-- `authenticated` (RLS-gated to org admins). That is not acceptable once a
-- batch has been applied or reversed: an admin's own session could delete
-- the row set that IS the audit trail for real money movement. Revoke
-- direct DELETE entirely; provide one small admin-only RPC that permits
-- deleting ONLY an abandoned draft/validated/failed batch that was never
-- applied and has zero ledger entries attached to any of its rows.

REVOKE DELETE ON public.balance_import_batches FROM authenticated;
REVOKE DELETE ON public.balance_import_rows FROM authenticated;

CREATE OR REPLACE FUNCTION public.balance_cancel_draft_import_v1(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_org_id uuid;
  v_batch  public.balance_import_batches%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_batch
  FROM public.balance_import_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;

  v_org_id := v_batch.organization_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = v_org_id
      AND om.role = 'admin' AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Only an admin of this organization may cancel an import batch';
  END IF;

  IF v_batch.status NOT IN ('draft', 'validated', 'failed') THEN
    RAISE EXCEPTION 'Only a draft, validated, or failed batch can be cancelled -- this batch is %', v_batch.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.balance_import_rows r
    WHERE r.batch_id = v_batch.id AND r.ledger_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'This batch has ledger entries attached and cannot be cancelled';
  END IF;

  DELETE FROM public.balance_import_rows WHERE batch_id = v_batch.id;
  DELETE FROM public.balance_import_batches WHERE id = v_batch.id;

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch.id);
END;
$$;

REVOKE ALL ON FUNCTION public.balance_cancel_draft_import_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_cancel_draft_import_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_cancel_draft_import_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.balance_cancel_draft_import_v1(uuid) IS
  'DOC-099. The only way to delete an import batch now that direct client '
  'DELETE is revoked. Admin-only, and only for a batch that was never '
  'applied/reversed and has zero attached ledger entries -- applied financial '
  'history can never be deleted, only reversed via balance_reverse_import_v1.';

NOTIFY pgrst, 'reload schema';
