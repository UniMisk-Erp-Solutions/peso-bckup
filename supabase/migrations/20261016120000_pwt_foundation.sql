-- PesoWise -> TallyPrime ("pwt") integration foundation.
--
-- ADDITIVE and NAMESPACED: every object is `pwt_*`. Nothing in the existing tally_* tables or
-- functions is altered. Apply manually, to the PesoWise project database only
-- (see Documentations MD/pesowise-tally-complete-guide.md, Part C).
--
-- Self-contained: it needs only public.organization_memberships (role / is_active) and
-- public.expenses (approval_tier, deleted_at), plus the existing report functions
-- report_expense_rows_v1, report_detailed_expense_rows_v4 and report_daily_project_rows_v1.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pwt_mapping_config (
  organization_id uuid PRIMARY KEY,
  config          jsonb NOT NULL,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pwt_pairing_codes (
  code_hash       text PRIMARY KEY,
  organization_id uuid NOT NULL,
  tally_company   text NOT NULL CHECK (length(btrim(tally_company)) > 0),
  created_by      uuid,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

CREATE TABLE IF NOT EXISTS public.pwt_connectors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  device_name     text NOT NULL DEFAULT '',
  tally_company   text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  tally_version   text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  paired_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  last_active_company text,
  last_error      text
);
CREATE INDEX IF NOT EXISTS pwt_connectors_org_idx ON public.pwt_connectors (organization_id, status);

CREATE TABLE IF NOT EXISTS public.pwt_sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  report_type      text NOT NULL CHECK (report_type IN
                     ('daily_project', 'detailed_expense', 'claim_verification', 'claim_approval')),
  parameters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  parameters_hash  text NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN
                     ('queued', 'preparing', 'delivering', 'completed', 'needs_attention', 'failed', 'cancelled')),
  tally_company    text NOT NULL,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  prepared_at      timestamptz,
  completed_at     timestamptz,
  worker_id        text,
  lease_until      timestamptz,
  progress_current integer NOT NULL DEFAULT 0,
  progress_total   integer,
  row_count        integer NOT NULL DEFAULT 0,
  posted_count     integer NOT NULL DEFAULT 0,
  voucher_count    integer NOT NULL DEFAULT 0,
  issue_count      integer NOT NULL DEFAULT 0,
  blocking_count   integer NOT NULL DEFAULT 0,
  issues           jsonb NOT NULL DEFAULT '[]'::jsonb,
  error            text,
  config_snapshot  jsonb
);
CREATE INDEX IF NOT EXISTS pwt_sync_jobs_org_idx ON public.pwt_sync_jobs (organization_id, created_at DESC);
-- Only one active job per identical request: a double click returns the running job.
CREATE UNIQUE INDEX IF NOT EXISTS pwt_sync_jobs_active_dedupe
  ON public.pwt_sync_jobs (organization_id, report_type, parameters_hash)
  WHERE status IN ('queued', 'preparing', 'delivering');

-- Immutable job snapshot of the report rows exactly as read (audit + replay).
CREATE TABLE IF NOT EXISTS public.pwt_job_rows (
  job_id       uuid NOT NULL REFERENCES public.pwt_sync_jobs (id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  source_key   text NOT NULL,
  content_hash text NOT NULL,
  payload      jsonb NOT NULL,
  PRIMARY KEY (job_id, seq)
);

-- Canonical source-transaction registry: one row per PesoWise expense that has an accounting posting.
CREATE TABLE IF NOT EXISTS public.pwt_registry (
  organization_id uuid NOT NULL,
  source_id       text NOT NULL,
  state           text NOT NULL CHECK (state IN ('reserved', 'posted')),
  job_id          uuid NOT NULL,
  amount          numeric(14, 2) NOT NULL,
  voucher_number  text NOT NULL,
  voucher_date    date NOT NULL,
  content_hash    text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_id)
);

CREATE TABLE IF NOT EXISTS public.pwt_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES public.pwt_sync_jobs (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('masters', 'vouchers', 'report_rows')),
  xml             text NOT NULL,
  item_count      integer NOT NULL DEFAULT 0,
  voucher_numbers text[] NOT NULL DEFAULT '{}',
  expected        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- planned vouchers for readback reconciliation
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'verified', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  claimed_by      uuid,
  lease_until     timestamptz,
  not_before      timestamptz,
  response        jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS pwt_batches_claim_idx ON public.pwt_batches (job_id, status, seq);

CREATE TABLE IF NOT EXISTS public.pwt_vouchers (
  organization_id uuid NOT NULL,
  tally_company   text NOT NULL,
  voucher_date    date NOT NULL,
  voucher_number  text NOT NULL,
  serial          integer NOT NULL,
  batch_id        uuid NOT NULL REFERENCES public.pwt_batches (id) ON DELETE CASCADE,
  total           numeric(14, 2) NOT NULL,
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'posted', 'released')),
  PRIMARY KEY (organization_id, tally_company, voucher_date, voucher_number)
);

ALTER TABLE public.pwt_mapping_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_pairing_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_connectors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_sync_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_job_rows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_registry       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_batches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_vouchers       ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: the browser never reads these tables. UI goes through the SECURITY DEFINER
-- RPCs below (admin-checked); the worker and connector use the service role.
REVOKE ALL ON public.pwt_mapping_config, public.pwt_pairing_codes, public.pwt_connectors,
  public.pwt_sync_jobs, public.pwt_job_rows, public.pwt_registry, public.pwt_batches, public.pwt_vouchers
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Admin / UI RPCs  (authenticated, admin-checked per organisation)
-- ---------------------------------------------------------------------------------------------
-- Organisation admin only (no accountant/cashier): the caller's active membership role is 'admin'.
CREATE OR REPLACE FUNCTION public.pwt_org_admin_v1(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT m.role::text = 'admin'
      FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = p_org AND m.is_active = true
     LIMIT 1), false);
$$;

-- Claim metadata used by the worker (deleted claims are excluded, approval tier filter). Service role only.
CREATE OR REPLACE FUNCTION public.pwt_expense_meta_v1(p_organization_id uuid, p_expense_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_object_agg(e.id::text, jsonb_build_object('approval_tier', e.approval_tier, 'deleted_at', e.deleted_at)), '{}'::jsonb)
    FROM public.expenses e
   WHERE e.organization_id = p_organization_id AND e.id = ANY (p_expense_ids);
$$;

CREATE OR REPLACE FUNCTION public.pwt_assert_admin_v1(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000'; END IF;
  IF p_org IS NULL OR NOT public.pwt_org_admin_v1(p_org) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pwt_create_job_v1(
  p_organization_id uuid, p_report_type text, p_parameters jsonb, p_parameters_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company text; v_id uuid; v_existing uuid;
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  IF p_report_type NOT IN ('daily_project', 'detailed_expense', 'claim_verification', 'claim_approval') THEN
    RAISE EXCEPTION 'unsupported report type' USING ERRCODE = '22023';
  END IF;
  SELECT tally_company INTO v_company FROM public.pwt_connectors
   WHERE organization_id = p_organization_id AND status = 'active' ORDER BY paired_at DESC LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'no Tally connector is paired for this organisation' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_existing FROM public.pwt_sync_jobs
   WHERE organization_id = p_organization_id AND report_type = p_report_type
     AND parameters_hash = p_parameters_hash AND status IN ('queued', 'preparing', 'delivering');
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('job_id', v_existing, 'deduplicated', true);
  END IF;
  INSERT INTO public.pwt_sync_jobs (organization_id, report_type, parameters, parameters_hash, tally_company, created_by)
  VALUES (p_organization_id, p_report_type, COALESCE(p_parameters, '{}'::jsonb), p_parameters_hash, v_company, auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('job_id', v_id, 'deduplicated', false, 'tally_company', v_company);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_list_jobs_v1(p_organization_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at DESC) FROM (
      SELECT id, report_type, status, tally_company, created_at, completed_at, row_count, posted_count,
             voucher_count, issue_count, blocking_count, error, progress_current, progress_total,
             CASE WHEN status IN ('needs_attention', 'failed') THEN issues ELSE '[]'::jsonb END AS issues
        FROM public.pwt_sync_jobs WHERE organization_id = p_organization_id
       ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 100)
    ) j), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_create_pairing_code_v1(
  p_organization_id uuid, p_code_hash text, p_tally_company text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  IF length(btrim(COALESCE(p_tally_company, ''))) = 0 THEN
    RAISE EXCEPTION 'tally company is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pwt_pairing_codes (code_hash, organization_id, tally_company, created_by, expires_at)
  VALUES (p_code_hash, p_organization_id, btrim(p_tally_company), auth.uid(), now() + interval '15 minutes');
  RETURN jsonb_build_object('expires_in_seconds', 900);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_list_connectors_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.paired_at DESC) FROM (
    SELECT id, device_name, tally_company, tally_version, status, paired_at, last_seen_at, last_active_company, last_error
      FROM public.pwt_connectors WHERE organization_id = p_organization_id) c), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_revoke_connector_v1(p_organization_id uuid, p_connector uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  UPDATE public.pwt_connectors SET status = 'revoked' WHERE id = p_connector AND organization_id = p_organization_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Worker RPCs  (service role only)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_claim_job_v1(p_job_id uuid, p_worker text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.pwt_sync_jobs%ROWTYPE;
BEGIN
  UPDATE public.pwt_sync_jobs SET status = 'preparing', worker_id = p_worker,
         lease_until = now() + interval '10 minutes', started_at = COALESCE(started_at, now())
   WHERE id = p_job_id AND (status = 'queued' OR (status = 'preparing' AND lease_until < now()))
  RETURNING * INTO j;
  IF NOT FOUND THEN RETURN NULL; END IF;
  DELETE FROM public.pwt_job_rows WHERE job_id = p_job_id;  -- a re-claimed job re-reads from scratch
  RETURN to_jsonb(j);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_heartbeat_v1(p_job_id uuid, p_worker text, p_current integer, p_total integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.pwt_sync_jobs SET lease_until = now() + interval '10 minutes',
         progress_current = p_current, progress_total = p_total
   WHERE id = p_job_id AND worker_id = p_worker AND status = 'preparing';
$$;

CREATE OR REPLACE FUNCTION public.pwt_store_rows_v1(p_job_id uuid, p_worker text, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pwt_sync_jobs WHERE id = p_job_id AND worker_id = p_worker AND status = 'preparing') THEN
    RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.pwt_job_rows (job_id, seq, source_key, content_hash, payload)
  SELECT p_job_id, (r ->> 'seq')::int, r ->> 'source_key', r ->> 'content_hash', r -> 'payload'
    FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (job_id, seq) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Registry state used by the planner: what is already posted/reserved, and voucher numbering per date+serial.
CREATE OR REPLACE FUNCTION public.pwt_registry_state_v1(p_org uuid, p_tally_company text, p_source_ids text[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'posted', COALESCE((SELECT jsonb_object_agg(source_id, amount) FROM public.pwt_registry
                         WHERE organization_id = p_org AND source_id = ANY (p_source_ids)), '{}'::jsonb),
    'voucher_counts', COALESCE((SELECT jsonb_object_agg(k, c) FROM (
        SELECT voucher_date::text || '|' || serial::text AS k, count(*) AS c
          FROM public.pwt_vouchers
         WHERE organization_id = p_org AND tally_company = p_tally_company AND status <> 'released'
         GROUP BY 1) t), '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.pwt_complete_prep_v1(
  p_job_id uuid, p_worker text, p_batches jsonb, p_reservations jsonb, p_vouchers jsonb, p_summary jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.pwt_sync_jobs%ROWTYPE; b jsonb; v_batch uuid; v_has_work boolean;
BEGIN
  SELECT * INTO j FROM public.pwt_sync_jobs WHERE id = p_job_id AND worker_id = p_worker AND status = 'preparing' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job not owned by worker' USING ERRCODE = '42501'; END IF;

  FOR b IN SELECT * FROM jsonb_array_elements(COALESCE(p_batches, '[]'::jsonb)) LOOP
    INSERT INTO public.pwt_batches (job_id, seq, kind, xml, item_count, voucher_numbers, expected)
    VALUES (p_job_id, (b ->> 'seq')::int, b ->> 'kind', b ->> 'xml', COALESCE((b ->> 'item_count')::int, 0),
            COALESCE(ARRAY(SELECT jsonb_array_elements_text(b -> 'voucher_numbers')), '{}'),
            COALESCE(b -> 'expected', '{}'::jsonb))
    RETURNING id INTO v_batch;
    INSERT INTO public.pwt_vouchers (organization_id, tally_company, voucher_date, voucher_number, serial, batch_id, total)
    SELECT j.organization_id, j.tally_company, (x ->> 'date')::date, x ->> 'number', (x ->> 'serial')::int, v_batch, (x ->> 'total')::numeric
      FROM jsonb_array_elements(COALESCE(p_vouchers -> (b ->> 'seq'), '[]'::jsonb)) x;
  END LOOP;

  -- Reserve registry rows. A conflict means another job claimed the same expense first: abort, caller re-plans.
  INSERT INTO public.pwt_registry (organization_id, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash)
  SELECT j.organization_id, r ->> 'source_id', 'reserved', p_job_id, (r ->> 'amount')::numeric,
         r ->> 'voucher_number', (r ->> 'voucher_date')::date, r ->> 'content_hash'
    FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) r;

  v_has_work := EXISTS (SELECT 1 FROM public.pwt_batches WHERE job_id = p_job_id);
  UPDATE public.pwt_sync_jobs SET
    status = CASE WHEN v_has_work THEN 'delivering'
                  WHEN COALESCE((p_summary ->> 'blocking_count')::int, 0) > 0 THEN 'needs_attention'
                  ELSE 'completed' END,
    prepared_at = now(),
    completed_at = CASE WHEN v_has_work THEN NULL ELSE now() END,
    row_count = COALESCE((p_summary ->> 'row_count')::int, 0),
    posted_count = COALESCE((p_summary ->> 'posted_count')::int, 0),
    voucher_count = COALESCE((p_summary ->> 'voucher_count')::int, 0),
    issue_count = COALESCE((p_summary ->> 'issue_count')::int, 0),
    blocking_count = COALESCE((p_summary ->> 'blocking_count')::int, 0),
    issues = COALESCE(p_summary -> 'issues', '[]'::jsonb),
    config_snapshot = p_summary -> 'config'
   WHERE id = p_job_id;
  RETURN jsonb_build_object('batches', (SELECT count(*) FROM public.pwt_batches WHERE job_id = p_job_id));
END $$;

CREATE OR REPLACE FUNCTION public.pwt_fail_job_v1(p_job_id uuid, p_worker text, p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.pwt_sync_jobs SET status = 'failed', error = left(p_error, 1000), completed_at = now()
   WHERE id = p_job_id AND (worker_id = p_worker OR p_worker IS NULL) AND status IN ('queued', 'preparing');
  DELETE FROM public.pwt_registry WHERE job_id = p_job_id AND state = 'reserved';
END $$;

-- ---------------------------------------------------------------------------------------------
-- Connector RPCs  (service role only; the edge function authenticates the device token)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_pair_v1(p_code_hash text, p_token_hash text, p_device text, p_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pwt_pairing_codes%ROWTYPE; v_id uuid;
BEGIN
  UPDATE public.pwt_pairing_codes SET used_at = now()
   WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now() RETURNING * INTO c;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid or expired pairing code' USING ERRCODE = '28000'; END IF;
  INSERT INTO public.pwt_connectors (organization_id, device_name, tally_company, token_hash, tally_version, last_seen_at)
  VALUES (c.organization_id, left(COALESCE(p_device, ''), 120), c.tally_company, p_token_hash, p_version, now())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('connector_id', v_id, 'organization_id', c.organization_id, 'tally_company', c.tally_company);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_connector_auth_v1(p_token_hash text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(c) - 'token_hash' FROM public.pwt_connectors c WHERE token_hash = p_token_hash AND status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.pwt_heartbeat_connector_v1(p_connector uuid, p_active_company text, p_version text, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.pwt_connectors SET last_seen_at = now(), last_active_company = p_active_company,
         tally_version = COALESCE(p_version, tally_version), last_error = left(p_error, 500)
   WHERE id = p_connector;
$$;

-- Claim the next deliverable batch. Strictly sequential per job (masters before vouchers) and only
-- when Tally's ACTIVE company equals the company the job was created for (wrong-company protection).
CREATE OR REPLACE FUNCTION public.pwt_claim_batch_v1(p_connector uuid, p_active_company text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pwt_connectors%ROWTYPE; b public.pwt_batches%ROWTYPE; j public.pwt_sync_jobs%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.pwt_connectors WHERE id = p_connector AND status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT bb.* INTO b FROM public.pwt_batches bb
    JOIN public.pwt_sync_jobs jj ON jj.id = bb.job_id
   WHERE jj.organization_id = c.organization_id AND jj.status = 'delivering'
     AND jj.tally_company = c.tally_company
     AND (bb.status = 'pending' AND (bb.not_before IS NULL OR bb.not_before <= now())
          OR (bb.status = 'claimed' AND bb.lease_until < now()))
     AND NOT EXISTS (SELECT 1 FROM public.pwt_batches lo
                      WHERE lo.job_id = bb.job_id AND lo.seq < bb.seq AND lo.status <> 'verified')
   ORDER BY jj.created_at, bb.seq LIMIT 1 FOR UPDATE OF bb SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_active_company IS DISTINCT FROM c.tally_company THEN
    UPDATE public.pwt_connectors SET last_error = 'Active Tally company does not match the paired company'
     WHERE id = p_connector;
    RETURN jsonb_build_object('blocked', 'wrong_company', 'expected', c.tally_company);
  END IF;

  UPDATE public.pwt_batches SET status = 'claimed', claimed_by = p_connector, attempts = attempts + 1,
         lease_until = now() + interval '3 minutes' WHERE id = b.id RETURNING * INTO b;
  SELECT * INTO j FROM public.pwt_sync_jobs WHERE id = b.job_id;
  RETURN jsonb_build_object('batch_id', b.id, 'job_id', b.job_id, 'seq', b.seq, 'kind', b.kind, 'xml', b.xml,
                            'expected', b.expected, 'tally_company', j.tally_company, 'attempt', b.attempts,
                            'report_type', j.report_type);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_ack_batch_v1(
  p_connector uuid, p_batch uuid, p_verified boolean, p_response jsonb, p_error text, p_permanent boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.pwt_batches%ROWTYPE; j public.pwt_sync_jobs%ROWTYPE; v_left integer;
BEGIN
  SELECT * INTO b FROM public.pwt_batches WHERE id = p_batch AND claimed_by = p_connector AND status = 'claimed' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ignored', true); END IF;
  SELECT * INTO j FROM public.pwt_sync_jobs WHERE id = b.job_id FOR UPDATE;

  IF p_verified THEN
    UPDATE public.pwt_batches SET status = 'verified', verified_at = now(), response = p_response, error = NULL WHERE id = b.id;
    UPDATE public.pwt_vouchers SET status = 'posted' WHERE batch_id = b.id;
    SELECT count(*) INTO v_left FROM public.pwt_batches WHERE job_id = b.job_id AND status <> 'verified';
    IF v_left = 0 THEN
      UPDATE public.pwt_registry SET state = 'posted', updated_at = now() WHERE job_id = b.job_id AND state = 'reserved';
      UPDATE public.pwt_sync_jobs SET status = CASE WHEN blocking_count > 0 THEN 'needs_attention' ELSE 'completed' END,
             completed_at = now() WHERE id = b.job_id;
    END IF;
    RETURN jsonb_build_object('verified', true, 'job_done', v_left = 0);
  END IF;

  -- Not verified: never mark complete. Retry with backoff unless permanent / out of attempts.
  IF p_permanent OR b.attempts >= 5 THEN
    UPDATE public.pwt_batches SET status = 'failed', response = p_response, error = left(p_error, 1000) WHERE id = b.id;
    UPDATE public.pwt_sync_jobs SET status = 'needs_attention', error = left(p_error, 1000), completed_at = now() WHERE id = b.job_id;
    -- Vouchers already verified in Tally stay posted; their expenses must remain in the registry so a
    -- later sync can never post them twice. Only reservations whose voucher never verified are released.
    UPDATE public.pwt_registry r SET state = 'posted', updated_at = now()
     WHERE r.job_id = b.job_id AND r.state = 'reserved'
       AND EXISTS (SELECT 1 FROM public.pwt_vouchers v
                    WHERE v.organization_id = r.organization_id AND v.tally_company = j.tally_company
                      AND v.voucher_date = r.voucher_date AND v.voucher_number = r.voucher_number AND v.status = 'posted');
    UPDATE public.pwt_vouchers SET status = 'released'
     WHERE status = 'planned' AND batch_id IN (SELECT id FROM public.pwt_batches WHERE job_id = b.job_id);
    DELETE FROM public.pwt_registry WHERE job_id = b.job_id AND state = 'reserved';
    RETURN jsonb_build_object('failed', true);
  END IF;
  -- TallyPrime being offline is not the batch's fault: refund the attempt so an outage never exhausts retries.
  UPDATE public.pwt_batches SET status = 'pending', claimed_by = NULL, lease_until = NULL, response = p_response,
         error = left(p_error, 1000),
         attempts = CASE WHEN COALESCE(p_response ->> 'offline', 'false') = 'true' THEN GREATEST(b.attempts - 1, 0) ELSE b.attempts END,
         not_before = now() + (CASE WHEN COALESCE(p_response ->> 'offline', 'false') = 'true' THEN 1 ELSE b.attempts END) * interval '30 seconds'
   WHERE id = b.id;
  RETURN jsonb_build_object('retry', true);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.pwt_org_admin_v1(uuid), public.pwt_expense_meta_v1(uuid, uuid[]),
  public.pwt_assert_admin_v1(uuid), public.pwt_create_job_v1(uuid, text, jsonb, text), public.pwt_list_jobs_v1(uuid, integer),
  public.pwt_create_pairing_code_v1(uuid, text, text), public.pwt_list_connectors_v1(uuid), public.pwt_revoke_connector_v1(uuid, uuid),
  public.pwt_claim_job_v1(uuid, text), public.pwt_heartbeat_v1(uuid, text, integer, integer), public.pwt_store_rows_v1(uuid, text, jsonb),
  public.pwt_registry_state_v1(uuid, text, text[]), public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.pwt_fail_job_v1(uuid, text, text), public.pwt_pair_v1(text, text, text, text), public.pwt_connector_auth_v1(text),
  public.pwt_heartbeat_connector_v1(uuid, text, text, text), public.pwt_claim_batch_v1(uuid, text),
  public.pwt_ack_batch_v1(uuid, uuid, boolean, jsonb, text, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.pwt_create_job_v1(uuid, text, jsonb, text), public.pwt_list_jobs_v1(uuid, integer),
  public.pwt_create_pairing_code_v1(uuid, text, text), public.pwt_list_connectors_v1(uuid),
  public.pwt_revoke_connector_v1(uuid, uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.pwt_expense_meta_v1(uuid, uuid[]) TO service_role;

GRANT EXECUTE ON FUNCTION
  public.pwt_create_job_v1(uuid, text, jsonb, text), public.pwt_claim_job_v1(uuid, text),
  public.pwt_heartbeat_v1(uuid, text, integer, integer), public.pwt_store_rows_v1(uuid, text, jsonb),
  public.pwt_registry_state_v1(uuid, text, text[]), public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.pwt_fail_job_v1(uuid, text, text), public.pwt_pair_v1(text, text, text, text), public.pwt_connector_auth_v1(text),
  public.pwt_heartbeat_connector_v1(uuid, text, text, text), public.pwt_claim_batch_v1(uuid, text),
  public.pwt_ack_batch_v1(uuid, uuid, boolean, jsonb, text, boolean) TO service_role;
