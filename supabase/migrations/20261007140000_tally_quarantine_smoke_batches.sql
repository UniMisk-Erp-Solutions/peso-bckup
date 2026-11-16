-- Phase 5.3 — quarantine obsolete pending delivery batches (preserve audit trail).

CREATE OR REPLACE FUNCTION public.admin_quarantine_tally_delivery_batches_v1(
  p_organization_id uuid,
  p_batch_ids         uuid[],
  p_reason            text DEFAULT 'Superseded after Phase 5 metadata-voucher to metadata-ledger architecture migration; must not be delivered.'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_updated integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.tally_sync_admin_can_view_v1(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_batch_ids IS NULL OR array_length(p_batch_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_batch_ids required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tally_sync_delivery_batches b
  SET status = 'skipped',
      last_error_safe = left(COALESCE(p_reason, 'quarantined'), 300),
      ack_summary = COALESCE(b.ack_summary, '{}'::jsonb) || jsonb_build_object(
        'quarantined', true,
        'quarantine_reason', left(COALESCE(p_reason, 'quarantined'), 500),
        'quarantined_at', now()
      ),
      updated_at = now(),
      completed_at = COALESCE(completed_at, now())
  WHERE b.organization_id = p_organization_id
    AND b.id = ANY (p_batch_ids)
    AND b.status = 'pending';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'updated', v_updated,
    'batch_ids', to_jsonb(p_batch_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_quarantine_tally_delivery_batches_v1(uuid, uuid[], text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_quarantine_tally_delivery_batches_v1(uuid, uuid[], text) TO authenticated;

COMMENT ON FUNCTION public.admin_quarantine_tally_delivery_batches_v1(uuid, uuid[], text) IS
  'Admin-only: mark specific pending delivery batches skipped/quarantined — never delivered, audit preserved.';
