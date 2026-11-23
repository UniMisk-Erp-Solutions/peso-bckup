-- Fix: load RPCs failed in partial Phase 5 apply (plpgsql/sql body).

CREATE OR REPLACE FUNCTION public.load_tally_sync_job_items_v1(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'seq', i.seq,
    'source_type', i.source_type,
    'source_key', i.source_key,
    'content_hash', i.content_hash,
    'payload', i.payload
  ) ORDER BY i.seq), '[]'::jsonb)
  FROM public.tally_sync_job_items i
  WHERE i.job_id = p_job_id;
$$;

REVOKE ALL ON FUNCTION public.load_tally_sync_job_items_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_tally_sync_job_items_v1(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.load_tally_delivery_state_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'organization_id', d.organization_id,
    'delivery_key', d.delivery_key,
    'delivery_kind', d.delivery_kind,
    'last_content_hash', d.last_content_hash,
    'tally_remote_id', d.tally_remote_id,
    'last_action', d.last_action,
    'last_job_id', d.last_job_id,
    'peso_deleted_at', d.peso_deleted_at,
    'cancel_strategy', d.cancel_strategy
  )), '[]'::jsonb)
  FROM public.tally_delivery_state d
  WHERE d.organization_id = p_organization_id;
$$;

REVOKE ALL ON FUNCTION public.load_tally_delivery_state_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_tally_delivery_state_v1(uuid) TO service_role;
