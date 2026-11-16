-- Chunked Tally delivery enqueue (large prepared jobs).

CREATE OR REPLACE FUNCTION public.load_tally_sync_job_items_page_v1(
  p_job_id uuid,
  p_after_seq integer,
  p_limit integer
)
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
  FROM (
    SELECT seq, source_type, source_key, content_hash, payload
    FROM public.tally_sync_job_items
    WHERE job_id = p_job_id AND seq > COALESCE(p_after_seq, 0)
    ORDER BY seq
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000))
  ) i;
$$;

REVOKE ALL ON FUNCTION public.load_tally_sync_job_items_page_v1(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_tally_sync_job_items_page_v1(uuid, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.append_tally_delivery_batches_v1(
  p_job_id uuid,
  p_batches jsonb,
  p_finalize boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.tally_sync_jobs%ROWTYPE;
  v_batch jsonb;
  v_n integer := 0;
  v_offset integer;
BEGIN
  SELECT * INTO v_job FROM public.tally_sync_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found' USING ERRCODE = '22023'; END IF;
  IF v_job.status NOT IN ('prepared', 'waiting_for_connector') THEN
    RAISE EXCEPTION 'job not ready for delivery enqueue: %', v_job.status USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(max(batch_index), -1) + 1 INTO v_offset
  FROM public.tally_sync_delivery_batches WHERE job_id = p_job_id;

  FOR v_batch IN SELECT * FROM jsonb_array_elements(COALESCE(p_batches, '[]'::jsonb))
  LOOP
    INSERT INTO public.tally_sync_delivery_batches (
      job_id, organization_id, batch_index, message_count, xml_payload, delivery_updates, status
    ) VALUES (
      p_job_id,
      v_job.organization_id,
      v_offset + COALESCE((v_batch->>'batch_index')::integer, 0),
      COALESCE((v_batch->>'message_count')::integer, 0),
      COALESCE(v_batch->>'xml', ''),
      COALESCE(v_batch->'delivery_updates', '[]'::jsonb),
      CASE WHEN COALESCE((v_batch->>'message_count')::integer, 0) = 0 THEN 'skipped' ELSE 'pending' END
    )
    ON CONFLICT (job_id, batch_index) DO UPDATE
    SET message_count = EXCLUDED.message_count,
        xml_payload = EXCLUDED.xml_payload,
        delivery_updates = EXCLUDED.delivery_updates,
        status = EXCLUDED.status,
        updated_at = now();
    v_n := v_n + 1;
  END LOOP;

  IF p_finalize THEN
    UPDATE public.tally_sync_jobs
    SET status = CASE WHEN NOT EXISTS (
          SELECT 1 FROM public.tally_sync_delivery_batches b
          WHERE b.job_id = p_job_id AND b.status = 'pending'
        ) THEN 'completed'
        ELSE 'waiting_for_connector' END,
        completed_at = CASE WHEN NOT EXISTS (
          SELECT 1 FROM public.tally_sync_delivery_batches b WHERE b.job_id = p_job_id AND b.status = 'pending'
        ) THEN now() ELSE completed_at END
    WHERE id = p_job_id;
  END IF;

  RETURN jsonb_build_object(
    'appended', v_n,
    'batch_total', (SELECT count(*)::int FROM public.tally_sync_delivery_batches WHERE job_id = p_job_id),
    'job_status', (SELECT status FROM public.tally_sync_jobs WHERE id = p_job_id),
    'finalize', p_finalize
  );
END;
$$;

REVOKE ALL ON FUNCTION public.append_tally_delivery_batches_v1(uuid, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_tally_delivery_batches_v1(uuid, jsonb, boolean) TO service_role;
