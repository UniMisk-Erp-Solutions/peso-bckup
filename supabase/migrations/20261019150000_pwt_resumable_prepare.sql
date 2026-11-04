-- PesoWise -> TallyPrime: RESUMABLE job preparation (fixes large syncs that stayed "Preparing" forever).
--
-- The edge runtime cancels a single request after about 12 seconds, so reading and planning a report of ~13,000 rows in ONE request was killed
-- part-way (no error recorded, job stuck). Preparation now runs in short SLICES: each slice reads/plans for a few seconds, saves where it
-- stopped, and the next slice continues from exactly there. Nothing already read is read again.
--
-- ADDITIVE and idempotent. Apply manually, PesoWise DB only. Needs 20261016120000_pwt_foundation.sql.

ALTER TABLE public.pwt_sync_jobs
  ADD COLUMN IF NOT EXISTS prep_phase        text NOT NULL DEFAULT 'read',
  ADD COLUMN IF NOT EXISTS prep_state        jsonb,
  ADD COLUMN IF NOT EXISTS prep_seq          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS slice_lease_until timestamptz;

-- Claim the next slice of a job. Only ONE slice runs at a time (a short lease); an expired lease means that slice died and the next
-- claimer simply continues from the last saved state. A job that has never saved state starts from scratch (stale rows are cleared).
CREATE OR REPLACE FUNCTION public.pwt_claim_slice_v1(p_job_id uuid, p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.pwt_sync_jobs%ROWTYPE;
BEGIN
  UPDATE public.pwt_sync_jobs SET status = 'preparing', worker_id = p_worker,
         slice_lease_until = now() + interval '30 seconds', lease_until = now() + interval '30 minutes',
         started_at = COALESCE(started_at, now())
   WHERE id = p_job_id AND (status = 'queued' OR (status = 'preparing' AND COALESCE(slice_lease_until, 'epoch') < now()))
  RETURNING * INTO j;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF j.prep_state IS NULL THEN
    DELETE FROM public.pwt_job_rows WHERE job_id = p_job_id;   -- fresh start: never mix with rows of an abandoned attempt
    UPDATE public.pwt_sync_jobs SET prep_seq = 0, prep_phase = 'read' WHERE id = p_job_id RETURNING * INTO j;
  END IF;
  RETURN to_jsonb(j);
END $$;

-- Save where the slice stopped (and release the lease so the next slice can start at once).
CREATE OR REPLACE FUNCTION public.pwt_slice_save_v1(
  p_job_id uuid, p_worker text, p_phase text, p_state jsonb, p_seq integer, p_current integer, p_total integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_phase NOT IN ('read', 'plan') THEN RAISE EXCEPTION 'bad phase' USING ERRCODE = '22023'; END IF;
  UPDATE public.pwt_sync_jobs SET prep_phase = p_phase, prep_state = p_state, prep_seq = p_seq,
         progress_current = p_current, progress_total = p_total, slice_lease_until = NULL, lease_until = now() + interval '30 minutes'
   WHERE id = p_job_id AND worker_id = p_worker AND status = 'preparing';
  IF NOT FOUND THEN RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501'; END IF;
END $$;

-- Only the fields the planner reads, for a seq range of the stored snapshot (a fraction of the size of the full rows).
CREATE OR REPLACE FUNCTION public.pwt_job_rows_compact_v1(p_job_id uuid, p_from integer, p_to integer, p_keys text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(
           (SELECT COALESCE(jsonb_object_agg(k, r.payload -> k), '{}'::jsonb) FROM unnest(p_keys) k WHERE r.payload ? k)
           ORDER BY r.seq), '[]'::jsonb)
    FROM public.pwt_job_rows r
   WHERE r.job_id = p_job_id AND r.seq BETWEEN p_from AND p_to;
$$;

REVOKE ALL ON FUNCTION public.pwt_claim_slice_v1(uuid, text), public.pwt_slice_save_v1(uuid, text, text, jsonb, integer, integer, integer),
  public.pwt_job_rows_compact_v1(uuid, integer, integer, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_claim_slice_v1(uuid, text), public.pwt_slice_save_v1(uuid, text, text, jsonb, integer, integer, integer),
  public.pwt_job_rows_compact_v1(uuid, integer, integer, text[]) TO service_role;
