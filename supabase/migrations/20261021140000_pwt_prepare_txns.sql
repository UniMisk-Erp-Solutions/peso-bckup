-- PesoWise -> TallyPrime: preparation of a LARGE report in small CPU steps.
--
-- The edge runtime allows only about 2 seconds of CPU per request. Turning 12,000+ report rows into canonical transactions (hashing every
-- row) took longer than that in one request, so the planning step was cancelled. Preparation is now: read (slices) -> normalise (slices, each
-- a bounded number of rows) -> plan (grouping only). Normalised transactions are staged in pwt_job_txns between slices.
--
-- ADDITIVE and idempotent. Apply manually, PesoWise DB only. Needs 20261019150000_pwt_resumable_prepare.sql.

CREATE TABLE IF NOT EXISTS public.pwt_job_txns (
  job_id  uuid    NOT NULL REFERENCES public.pwt_sync_jobs (id) ON DELETE CASCADE,
  seq     integer NOT NULL,          -- chunk number
  payload jsonb   NOT NULL,          -- { post, view, same, issues, unmapped }
  PRIMARY KEY (job_id, seq)
);
ALTER TABLE public.pwt_job_txns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pwt_job_txns FROM PUBLIC, anon, authenticated;

-- A re-run of a lost slice writes the same chunk again: replace, never duplicate.
CREATE OR REPLACE FUNCTION public.pwt_store_txns_v1(p_job_id uuid, p_worker text, p_seq integer, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pwt_sync_jobs WHERE id = p_job_id AND worker_id = p_worker AND status = 'preparing') THEN
    RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.pwt_job_txns (job_id, seq, payload) VALUES (p_job_id, p_seq, p_payload)
  ON CONFLICT (job_id, seq) DO UPDATE SET payload = EXCLUDED.payload;
END $$;

CREATE OR REPLACE FUNCTION public.pwt_load_txns_v1(p_job_id uuid, p_from integer, p_to integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(payload ORDER BY seq), '[]'::jsonb) FROM public.pwt_job_txns WHERE job_id = p_job_id AND seq BETWEEN p_from AND p_to;
$$;

-- The claim of a job with no saved state also clears staged transactions of an abandoned attempt.
CREATE OR REPLACE FUNCTION public.pwt_claim_slice_v1(p_job_id uuid, p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.pwt_sync_jobs%ROWTYPE;
BEGIN
  UPDATE public.pwt_sync_jobs SET status = 'preparing', worker_id = p_worker,
         slice_lease_until = now() + interval '20 seconds', lease_until = now() + interval '30 minutes',
         started_at = COALESCE(started_at, now())
   WHERE id = p_job_id AND (status = 'queued' OR (status = 'preparing' AND COALESCE(slice_lease_until, 'epoch') < now()))
  RETURNING * INTO j;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF j.prep_state IS NULL THEN
    DELETE FROM public.pwt_job_rows WHERE job_id = p_job_id;
    DELETE FROM public.pwt_job_txns WHERE job_id = p_job_id;
    UPDATE public.pwt_sync_jobs SET prep_seq = 0, prep_phase = 'read' WHERE id = p_job_id RETURNING * INTO j;
  END IF;
  RETURN to_jsonb(j);
END $$;

-- Phases are now read -> norm -> plan.
CREATE OR REPLACE FUNCTION public.pwt_slice_save_v1(
  p_job_id uuid, p_worker text, p_phase text, p_state jsonb, p_seq integer, p_current integer, p_total integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_phase NOT IN ('read', 'norm', 'plan') THEN RAISE EXCEPTION 'bad phase' USING ERRCODE = '22023'; END IF;
  UPDATE public.pwt_sync_jobs SET prep_phase = p_phase, prep_state = p_state, prep_seq = p_seq,
         progress_current = p_current, progress_total = p_total, slice_lease_until = NULL, lease_until = now() + interval '30 minutes'
   WHERE id = p_job_id AND worker_id = p_worker AND status = 'preparing';
  IF NOT FOUND THEN RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.pwt_store_txns_v1(uuid, text, integer, jsonb), public.pwt_load_txns_v1(uuid, integer, integer),
  public.pwt_claim_slice_v1(uuid, text), public.pwt_slice_save_v1(uuid, text, text, jsonb, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_store_txns_v1(uuid, text, integer, jsonb), public.pwt_load_txns_v1(uuid, integer, integer),
  public.pwt_claim_slice_v1(uuid, text), public.pwt_slice_save_v1(uuid, text, text, jsonb, integer, integer, integer) TO service_role;

-- A job that the previous worker version had already moved to the planning phase has no staged transactions: send it back through
-- normalising (its stored rows are kept), so it is planned from complete data rather than from nothing.
UPDATE public.pwt_sync_jobs
   SET prep_phase = 'norm', prep_state = jsonb_set(COALESCE(prep_state, '{}'::jsonb), '{norm}', '{"nextRow": 1, "chunk": 0}'::jsonb)
 WHERE status = 'preparing' AND prep_phase = 'plan' AND prep_seq > 0
   AND NOT EXISTS (SELECT 1 FROM public.pwt_job_txns t WHERE t.job_id = pwt_sync_jobs.id);
