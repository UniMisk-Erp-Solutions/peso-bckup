-- PesoWise <- TallyPrime ("pwt" inbound): employee payments entered in Tally become PesoWise balance credits.
--
-- ADDITIVE and SEPARATE from the outbound (PesoWise -> Tally) tables: every object is `pwt_inbound_*`.
-- It records money through the EXISTING balance engine (`_balance_apply_credit_core_v3`, kind `balance_credit`, the same
-- engine the existing "Import from Tally" uses). It never writes profiles.balance directly.
--
-- Direction (decided from the existing accounting logic, not assumed):
--   PesoWise CREDIT = money advanced to the employee (balance goes UP); approved expenses DEDUCT.
--   Tally: Dr on the employee ledger (Payment voucher: Dr employee / Cr cash-or-bank)  =>  PesoWise credit (+amount).
--   Cr on an employee ledger is a refund and is NEVER imported (reported as skipped).
--
-- Depends on: 20261016120000_pwt_foundation.sql (pwt_connectors, pwt_org_admin_v1) and the existing balance tables/functions
-- (profiles, organization_memberships, balance_import_batches/rows, _balance_apply_credit_core_v3).

CREATE TABLE IF NOT EXISTS public.pwt_inbound_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  tally_company         text NOT NULL,
  voucher_type          text NOT NULL DEFAULT 'PesoWise Payment',
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN
                          ('queued', 'fetching', 'processing', 'completed', 'needs_attention', 'failed', 'cancelled')),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  claimed_by            uuid,
  lease_until           timestamptz,
  fetch_complete        boolean NOT NULL DEFAULT false,
  completed_at          timestamptz,
  progress_current      integer NOT NULL DEFAULT 0,
  progress_total        integer,
  vouchers_fetched      integer NOT NULL DEFAULT 0,
  imported_count        integer NOT NULL DEFAULT 0,
  already_imported_count integer NOT NULL DEFAULT 0,
  skipped_count         integer NOT NULL DEFAULT 0,
  unmatched_count       integer NOT NULL DEFAULT 0,
  failed_count          integer NOT NULL DEFAULT 0,
  flagged_count         integer NOT NULL DEFAULT 0,
  imported_amount       numeric(14, 2) NOT NULL DEFAULT 0,
  batch_id              uuid,
  error                 text
);
ALTER TABLE public.pwt_inbound_jobs ADD COLUMN IF NOT EXISTS voucher_type text NOT NULL DEFAULT 'PesoWise Payment';

-- The EXACT Tally voucher type that carries employee payments (per organisation; default "PesoWise Payment").
CREATE TABLE IF NOT EXISTS public.pwt_inbound_settings (
  organization_id uuid PRIMARY KEY,
  voucher_type    text NOT NULL CHECK (length(btrim(voucher_type)) BETWEEN 1 AND 100),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pwt_inbound_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pwt_inbound_settings FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS pwt_inbound_jobs_org_idx ON public.pwt_inbound_jobs (organization_id, created_at DESC);
-- A double click returns the running job.
CREATE UNIQUE INDEX IF NOT EXISTS pwt_inbound_jobs_active_uidx
  ON public.pwt_inbound_jobs (organization_id) WHERE status IN ('queued', 'fetching', 'processing');

-- Vouchers exactly as fetched (immutable snapshot for audit/replay).
CREATE TABLE IF NOT EXISTS public.pwt_inbound_vouchers (
  job_id  uuid NOT NULL REFERENCES public.pwt_inbound_jobs (id) ON DELETE CASCADE,
  seq     integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (job_id, seq)
);

-- Durable idempotency + permanent audit trail: one row per (company, voucher, employee ledger).
CREATE TABLE IF NOT EXISTS public.pwt_inbound_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  tally_company   text NOT NULL,
  voucher_guid    text NOT NULL,
  ledger_name     text NOT NULL,
  voucher_number  text,
  voucher_date    date,
  amount          numeric(14, 2) NOT NULL,
  alter_id        bigint,
  master_id       bigint,
  narration       text,
  matched_user_id uuid,
  state           text NOT NULL CHECK (state IN
                    ('imported', 'unmatched', 'ambiguous', 'skipped', 'failed', 'changed_after_import', 'deleted_in_tally')),
  reason          text,
  ledger_entry_id uuid,
  import_batch_id uuid,
  job_id          uuid,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  imported_at     timestamptz,
  UNIQUE (organization_id, tally_company, voucher_guid, ledger_name)
);
CREATE INDEX IF NOT EXISTS pwt_inbound_payments_job_idx ON public.pwt_inbound_payments (job_id);

ALTER TABLE public.pwt_inbound_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_inbound_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_inbound_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pwt_inbound_jobs, public.pwt_inbound_vouchers, public.pwt_inbound_payments FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_inbound_create_job_v1(p_organization_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company text; v_existing uuid; v_id uuid;
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  SELECT tally_company INTO v_company FROM public.pwt_connectors
   WHERE organization_id = p_organization_id AND status = 'active' ORDER BY paired_at DESC LIMIT 1;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'no Tally connector is paired for this organisation' USING ERRCODE = 'P0001';
  END IF;
  SELECT id INTO v_existing FROM public.pwt_inbound_jobs
   WHERE organization_id = p_organization_id AND status IN ('queued', 'fetching', 'processing');
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('job_id', v_existing, 'deduplicated', true);
  END IF;
  INSERT INTO public.pwt_inbound_jobs (organization_id, tally_company, created_by, voucher_type)
  VALUES (p_organization_id, v_company, auth.uid(),
          COALESCE((SELECT voucher_type FROM public.pwt_inbound_settings WHERE organization_id = p_organization_id), 'PesoWise Payment'))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('job_id', v_id, 'deduplicated', false, 'tally_company', v_company);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_inbound_get_settings_v1(p_organization_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN jsonb_build_object('voucher_type',
    COALESCE((SELECT voucher_type FROM public.pwt_inbound_settings WHERE organization_id = p_organization_id), 'PesoWise Payment'));
END $$;

CREATE OR REPLACE FUNCTION public.pwt_inbound_set_voucher_type_v1(p_organization_id uuid, p_voucher_type text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  IF p_voucher_type IS NULL OR length(btrim(p_voucher_type)) = 0 OR length(btrim(p_voucher_type)) > 100 THEN
    RAISE EXCEPTION 'voucher type name is required (max 100 characters)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.pwt_inbound_settings (organization_id, voucher_type, updated_by) VALUES (p_organization_id, btrim(p_voucher_type), auth.uid())
  ON CONFLICT (organization_id) DO UPDATE SET voucher_type = EXCLUDED.voucher_type, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.pwt_inbound_list_jobs_v1(p_organization_id uuid, p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at DESC) FROM (
    SELECT id, status, tally_company, created_at, completed_at, vouchers_fetched, imported_count, already_imported_count,
           skipped_count, unmatched_count, failed_count, flagged_count, imported_amount, progress_current, progress_total, error
      FROM public.pwt_inbound_jobs WHERE organization_id = p_organization_id
     ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 50)) j), '[]'::jsonb);
END $$;

-- Rows that need a human (everything except plain imports), for the job's result screen.
CREATE OR REPLACE FUNCTION public.pwt_inbound_job_problems_v1(p_organization_id uuid, p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.voucher_date, p.voucher_number) FROM (
    SELECT voucher_number, voucher_date, ledger_name, amount, state, reason
      FROM public.pwt_inbound_payments
     WHERE organization_id = p_organization_id AND job_id = p_job_id AND state <> 'imported'
     ORDER BY voucher_date, voucher_number LIMIT 200) p), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Connector RPCs (service role; the edge function authenticates the device token first)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_inbound_claim_v1(p_connector uuid, p_active_company text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pwt_connectors%ROWTYPE; j public.pwt_inbound_jobs%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.pwt_connectors WHERE id = p_connector AND status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO j FROM public.pwt_inbound_jobs
   WHERE organization_id = c.organization_id AND tally_company = c.tally_company
     AND (status = 'queued' OR (status = 'fetching' AND lease_until < now()))
   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Wrong-company protection: never fetch from (or report on) a company other than the paired one.
  IF p_active_company IS DISTINCT FROM c.tally_company THEN
    RETURN jsonb_build_object('blocked', 'wrong_company', 'expected', c.tally_company);
  END IF;
  DELETE FROM public.pwt_inbound_vouchers WHERE job_id = j.id;   -- a re-claimed job re-reads from scratch
  UPDATE public.pwt_inbound_jobs SET status = 'fetching', claimed_by = p_connector, lease_until = now() + interval '10 minutes',
         progress_current = 0 WHERE id = j.id;
  RETURN jsonb_build_object('job_id', j.id, 'tally_company', j.tally_company, 'voucher_type', j.voucher_type);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_inbound_submit_v1(p_connector uuid, p_job uuid, p_seq_start integer, p_vouchers jsonb, p_total integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pwt_inbound_jobs WHERE id = p_job AND claimed_by = p_connector AND status = 'fetching') THEN
    RAISE EXCEPTION 'job not claimed by this connector' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.pwt_inbound_vouchers (job_id, seq, payload)
  SELECT p_job, p_seq_start + (t.ord - 1)::int, t.v
    FROM jsonb_array_elements(COALESCE(p_vouchers, '[]'::jsonb)) WITH ORDINALITY AS t(v, ord)
  ON CONFLICT (job_id, seq) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.pwt_inbound_jobs SET lease_until = now() + interval '10 minutes', progress_total = p_total,
         progress_current = (SELECT count(*) FROM public.pwt_inbound_vouchers WHERE job_id = p_job)
   WHERE id = p_job;
  RETURN jsonb_build_object('stored', n);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Processing: validate, match employees, dedupe, and credit through the existing engine. One transaction;
-- each payment runs in its own sub-transaction so one bad voucher never blocks or corrupts the others.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pwt_inbound_process_v1(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.pwt_inbound_jobs%ROWTYPE;
  v record; e record; r record;
  v_imported int := 0; v_already int := 0; v_skipped int := 0; v_unmatched int := 0; v_failed int := 0; v_flagged int := 0;
  v_amount numeric(14, 2) := 0;
  v_batch uuid; v_rowno int := 0;
  v_guids text[] := '{}';
  v_fp text;
  v_code text; v_name text; v_cnt int; v_user uuid; v_pname text;
  v_ok boolean; v_cr_ok boolean; v_dr numeric; v_cr numeric;
  v_amt numeric; v_date date; v_key text; v_res jsonb; v_reg public.pwt_inbound_payments%ROWTYPE;
  v_had boolean; v_changed boolean; v_note text; v_was_dup boolean;
  v_bank_parents text[] := ARRAY['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c', 'Bank Accounts and Cash'];
BEGIN
  SELECT * INTO j FROM public.pwt_inbound_jobs WHERE id = p_job_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtext('pwt_inbound:' || j.organization_id::text));
  -- Created up front (outside the per-payment sub-transactions); removed at the end if nothing new was credited.
  INSERT INTO public.balance_import_batches (organization_id, mode, status, original_filename, note, created_by, row_count)
  VALUES (j.organization_id, 'balance_credit', 'applying',
          'Tally sync: ' || j.tally_company || ' ' || to_char(now(), 'YYYY-MM-DD HH24:MI'),
          'Imported from TallyPrime (PesoWise Payment vouchers)', j.created_by, 0)
  RETURNING id INTO v_batch;

  FOR v IN
    SELECT p.payload AS d FROM public.pwt_inbound_vouchers p WHERE p.job_id = p_job_id ORDER BY p.seq
  LOOP
    DECLARE
      g text := v.d ->> 'guid';
      vno text := v.d ->> 'number';
      vtype text := v.d ->> 'type';
      vnar text := COALESCE(v.d ->> 'narration', '');
      valter bigint := NULLIF(v.d ->> 'alter_id', '')::bigint;
      vmaster bigint := NULLIF(v.d ->> 'master_id', '')::bigint;
      vskip text := NULL;
    BEGIN
      IF g IS NULL OR btrim(g) = '' THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      v_guids := v_guids || g;
      v_date := NULL;
      BEGIN v_date := (v.d ->> 'date')::date; EXCEPTION WHEN others THEN v_date := NULL; END;

      -- voucher-level eligibility (the server re-checks everything; it never trusts the connector)
      IF vtype IS DISTINCT FROM j.voucher_type THEN vskip := 'voucher type is not "' || j.voucher_type || '"';
      ELSIF vnar LIKE 'PWT %' THEN vskip := 'created by the PesoWise to Tally sync (not an employee payment)';
      ELSIF COALESCE((v.d ->> 'cancelled')::boolean, false) THEN vskip := 'voucher is cancelled in Tally';
      ELSIF COALESCE((v.d ->> 'optional')::boolean, false) THEN vskip := 'optional voucher (not posted in Tally)';
      ELSIF v_date IS NULL THEN vskip := 'invalid voucher date';
      END IF;

      -- balance + shape: debits must equal credits, and every credit must be a cash/bank ledger
      SELECT COALESCE(sum(-(x ->> 'amount')::numeric) FILTER (WHERE (x ->> 'amount')::numeric < 0), 0),
             COALESCE(sum((x ->> 'amount')::numeric) FILTER (WHERE (x ->> 'amount')::numeric > 0), 0),
             COALESCE(bool_and(COALESCE((x ->> 'parent') = ANY (v_bank_parents), false)) FILTER (WHERE (x ->> 'amount')::numeric > 0), false)
        INTO v_dr, v_cr, v_cr_ok
        FROM jsonb_array_elements(COALESCE(v.d -> 'entries', '[]'::jsonb)) x;
      IF vskip IS NULL AND (v_dr = 0 OR round(v_dr, 2) <> round(v_cr, 2)) THEN vskip := 'voucher is not balanced or has no debit'; END IF;
      IF vskip IS NULL AND NOT v_cr_ok THEN vskip := 'credit side is not a cash or bank ledger'; END IF;

      -- fingerprint of the debit entries (to detect edits after import)
      SELECT COALESCE(string_agg((lname || '=' || amt::text), ';' ORDER BY lname), '') INTO v_fp FROM (
        SELECT (x ->> 'ledger') AS lname, round(sum(-(x ->> 'amount')::numeric), 2) AS amt
          FROM jsonb_array_elements(COALESCE(v.d -> 'entries', '[]'::jsonb)) x
         WHERE (x ->> 'amount')::numeric < 0 GROUP BY 1) q;

      IF vskip IS NOT NULL THEN
        v_skipped := v_skipped + 1;
        -- an already-imported voucher that now fails eligibility (cancelled, retyped...) must be flagged, never silently kept
        UPDATE public.pwt_inbound_payments
           SET state = 'changed_after_import', reason = 'voucher changed after import (' || vskip || '); reconcile manually',
               last_seen_at = now(), job_id = p_job_id
         WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_guid = g
           AND ledger_entry_id IS NOT NULL AND state IN ('imported', 'changed_after_import', 'deleted_in_tally');
        IF FOUND THEN v_flagged := v_flagged + 1; END IF;
        INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date,
               amount, alter_id, master_id, narration, state, reason, job_id)
        VALUES (j.organization_id, j.tally_company, g, '(voucher)', vno, v_date, v_dr, valter, vmaster, left(vnar, 500), 'skipped', vskip, p_job_id)
        ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name)
        DO UPDATE SET state = 'skipped', reason = EXCLUDED.reason, last_seen_at = now(), job_id = p_job_id
          WHERE public.pwt_inbound_payments.state NOT IN ('imported', 'changed_after_import');
        CONTINUE;
      END IF;

      -- edits after import: compare ONLY what was actually imported with what the voucher says now.
      --  * an imported entry whose amount changed or disappeared, or a brand-new employee entry added to a voucher that already
      --    credited someone  =>  the voucher was edited: flag it and import nothing from it (no balance change)
      --  * entries that were merely skipped/unmatched/failed earlier are NOT edits (they may be retried)
      --  * an identical voucher that was flagged earlier (restored in Tally) is returned to 'imported'
      SELECT EXISTS (SELECT 1 FROM public.pwt_inbound_payments pr
                      WHERE pr.organization_id = j.organization_id AND pr.tally_company = j.tally_company AND pr.voucher_guid = g
                        AND pr.ledger_entry_id IS NOT NULL AND pr.state IN ('imported', 'changed_after_import', 'deleted_in_tally'))
        INTO v_had;
      IF v_had THEN
        SELECT EXISTS (
                 SELECT 1 FROM public.pwt_inbound_payments pr
                  WHERE pr.organization_id = j.organization_id AND pr.tally_company = j.tally_company AND pr.voucher_guid = g
                    AND pr.ledger_entry_id IS NOT NULL AND pr.state IN ('imported', 'changed_after_import', 'deleted_in_tally')
                    AND NOT EXISTS (SELECT 1 FROM (
                          SELECT (x ->> 'ledger') AS lname, round(sum(-(x ->> 'amount')::numeric), 2) AS amt
                            FROM jsonb_array_elements(COALESCE(v.d -> 'entries', '[]'::jsonb)) x
                           WHERE (x ->> 'amount')::numeric < 0 GROUP BY 1) d
                         WHERE d.lname = pr.ledger_name AND d.amt = pr.amount))
            OR EXISTS (
                 SELECT 1 FROM (
                          SELECT (x ->> 'ledger') AS lname
                            FROM jsonb_array_elements(COALESCE(v.d -> 'entries', '[]'::jsonb)) x
                           WHERE (x ->> 'amount')::numeric < 0 GROUP BY 1) d
                  WHERE NOT EXISTS (SELECT 1 FROM public.pwt_inbound_payments pr2
                                     WHERE pr2.organization_id = j.organization_id AND pr2.tally_company = j.tally_company
                                       AND pr2.voucher_guid = g AND pr2.ledger_name = d.lname))
          INTO v_changed;
        IF v_changed THEN
          UPDATE public.pwt_inbound_payments SET state = 'changed_after_import',
                 reason = 'voucher edited in Tally after import (now: ' || left(v_fp, 200) || '); balance not changed, reconcile manually',
                 last_seen_at = now(), job_id = p_job_id
           WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_guid = g
             AND ledger_entry_id IS NOT NULL AND state IN ('imported', 'changed_after_import', 'deleted_in_tally');
          v_flagged := v_flagged + 1;
          CONTINUE;
        ELSE
          UPDATE public.pwt_inbound_payments SET state = 'imported', reason = NULL, last_seen_at = now(), job_id = p_job_id
           WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_guid = g
             AND ledger_entry_id IS NOT NULL AND state IN ('changed_after_import', 'deleted_in_tally');
        END IF;
      END IF;

      -- one payment per employee ledger (several entries for the same ledger in one voucher are summed)
      FOR e IN
        SELECT (x ->> 'ledger') AS ledger, round(sum(-(x ->> 'amount')::numeric), 2) AS amt
          FROM jsonb_array_elements(v.d -> 'entries') x
         WHERE (x ->> 'amount')::numeric < 0 GROUP BY 1
      LOOP
        v_amt := e.amt;
        SELECT * INTO v_reg FROM public.pwt_inbound_payments
         WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_guid = g AND ledger_name = e.ledger;
        IF FOUND AND v_reg.state = 'imported' THEN
          v_already := v_already + 1;
          UPDATE public.pwt_inbound_payments SET alter_id = valter, narration = left(vnar, 500), last_seen_at = now(), job_id = p_job_id WHERE id = v_reg.id;
          CONTINUE;
        END IF;

        -- safety limit: an implausible amount is never credited (and must not overflow the audit columns)
        IF v_amt >= 1000000000 THEN
          v_failed := v_failed + 1;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, state, reason, job_id)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, 0, valter, vmaster, left(vnar, 500), 'failed',
                  'amount exceeds the safety limit of 1,000,000,000', p_job_id)
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'failed', reason = EXCLUDED.reason, last_seen_at = now(), job_id = p_job_id
           WHERE public.pwt_inbound_payments.state <> 'imported';
          CONTINUE;
        END IF;

        -- employee identification: "<name>-<employee code>", exact and unique inside this organisation
        v_user := NULL; v_pname := NULL;
        IF e.ledger ~ '^.*\S\s*-\s*[A-Za-z0-9]+$' THEN
          v_code := substring(e.ledger from '-\s*([A-Za-z0-9]+)$');
          v_name := lower(regexp_replace(btrim(regexp_replace(e.ledger, '\s*-\s*[A-Za-z0-9]+$', '')), '\s+', ' ', 'g'));
        ELSE
          v_code := NULL;
        END IF;

        IF v_code IS NULL THEN
          v_skipped := v_skipped + 1;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, state, reason, job_id)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, v_amt, valter, vmaster, left(vnar, 500), 'skipped',
                  'ledger is not an employee ledger (expected "<name>-<employee code>")', p_job_id)
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'skipped', reason = EXCLUDED.reason, amount = EXCLUDED.amount, last_seen_at = now(), job_id = p_job_id;
          CONTINUE;
        END IF;

        SELECT count(*) INTO v_cnt FROM public.profiles pr
          JOIN public.organization_memberships om ON om.user_id = pr.user_id AND om.organization_id = pr.organization_id AND om.is_active = true
         WHERE pr.organization_id = j.organization_id AND btrim(pr.employee_id::text) = v_code;
        IF v_cnt = 1 THEN
          SELECT pr.user_id, pr.name INTO v_user, v_pname FROM public.profiles pr
            JOIN public.organization_memberships om ON om.user_id = pr.user_id AND om.organization_id = pr.organization_id AND om.is_active = true
           WHERE pr.organization_id = j.organization_id AND btrim(pr.employee_id::text) = v_code;
        END IF;

        IF v_cnt > 1 THEN
          v_unmatched := v_unmatched + 1;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, state, reason, job_id)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, v_amt, valter, vmaster, left(vnar, 500), 'ambiguous',
                  'more than one employee has code ' || v_code, p_job_id)
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'ambiguous', reason = EXCLUDED.reason, amount = EXCLUDED.amount, last_seen_at = now(), job_id = p_job_id;
          CONTINUE;
        ELSIF v_cnt = 0 THEN
          v_unmatched := v_unmatched + 1;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, state, reason, job_id)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, v_amt, valter, vmaster, left(vnar, 500), 'unmatched',
                  'no active employee with code ' || v_code || ' in this organisation', p_job_id)
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'unmatched', reason = EXCLUDED.reason, amount = EXCLUDED.amount, last_seen_at = now(), job_id = p_job_id;
          CONTINUE;
        ELSIF lower(regexp_replace(btrim(COALESCE(v_pname, '')), '\s+', ' ', 'g')) <> v_name THEN
          v_unmatched := v_unmatched + 1;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, state, reason, job_id)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, v_amt, valter, vmaster, left(vnar, 500), 'unmatched',
                  'employee code ' || v_code || ' exists but the ledger name does not match that employee (not guessed)', p_job_id)
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'unmatched', reason = EXCLUDED.reason, amount = EXCLUDED.amount, last_seen_at = now(), job_id = p_job_id;
          CONTINUE;
        END IF;

        -- apply through the existing balance engine, in a sub-transaction
        v_key := 'tally:' || j.tally_company || ':' || g || ':' || e.ledger;
        v_note := 'Tally payment voucher ' || COALESCE(vno, '?') || ' (' || j.tally_company || ')';
        BEGIN
          v_res := public._balance_apply_credit_core_v3(j.organization_id, v_user, v_amt, 'balance_credit', v_date,
                                                        'import_batch_v3', v_batch, j.created_by, v_note, v_key);
          v_was_dup := COALESCE((v_res ->> 'already_applied')::boolean, false);   -- ledger already holds this exact credit (repairs a lost registry row)
          IF NOT v_was_dup THEN
            INSERT INTO public.balance_import_rows (batch_id, row_number, raw_employee_id, normalized_employee_id, matched_user_id,
                   current_balance_snapshot, input_amount, calculated_new_balance, effective_date, note, validation_status, ledger_entry_id)
            VALUES (v_batch, v_rowno + 1, v_code, v_code, v_user, (v_res ->> 'balance_before')::numeric, v_amt,
                    (v_res ->> 'balance_after')::numeric, v_date, v_note, 'valid', (v_res ->> 'ledger_entry_id')::uuid);
          END IF;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, matched_user_id, state, reason, ledger_entry_id, import_batch_id, job_id, imported_at)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, v_amt, valter, vmaster, left(vnar, 500), v_user, 'imported', NULL,
                  (v_res ->> 'ledger_entry_id')::uuid, v_batch, p_job_id, now())
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'imported', reason = NULL, amount = EXCLUDED.amount, matched_user_id = EXCLUDED.matched_user_id,
                 ledger_entry_id = EXCLUDED.ledger_entry_id, import_batch_id = EXCLUDED.import_batch_id, imported_at = now(),
                 last_seen_at = now(), job_id = p_job_id, alter_id = EXCLUDED.alter_id;
          -- counters last: nothing above can fail after this point, so the counts always match what was committed
          IF v_was_dup THEN
            v_already := v_already + 1;
          ELSE
            v_imported := v_imported + 1;
            v_amount := v_amount + v_amt;
            v_rowno := v_rowno + 1;
          END IF;
        EXCEPTION WHEN others THEN
          v_failed := v_failed + 1;
          INSERT INTO public.pwt_inbound_payments (organization_id, tally_company, voucher_guid, ledger_name, voucher_number, voucher_date, amount,
                 alter_id, master_id, narration, matched_user_id, state, reason, job_id)
          VALUES (j.organization_id, j.tally_company, g, e.ledger, vno, v_date, v_amt, valter, vmaster, left(vnar, 500), v_user, 'failed',
                  left(SQLERRM, 300), p_job_id)
          ON CONFLICT (organization_id, tally_company, voucher_guid, ledger_name) DO UPDATE
             SET state = 'failed', reason = EXCLUDED.reason, last_seen_at = now(), job_id = p_job_id
           WHERE public.pwt_inbound_payments.state <> 'imported';
        END;
      END LOOP;
    END;
  END LOOP;

  -- deleted in Tally: previously imported vouchers that are no longer returned (only when the fetch was complete)
  IF j.fetch_complete THEN
    FOR r IN
      SELECT id FROM public.pwt_inbound_payments
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND state = 'imported'
         AND NOT (voucher_guid = ANY (v_guids))
    LOOP
      UPDATE public.pwt_inbound_payments SET state = 'deleted_in_tally',
             reason = 'voucher no longer exists in Tally; the credit was NOT reversed, reconcile manually', last_seen_at = now(), job_id = p_job_id
       WHERE id = r.id;
      v_flagged := v_flagged + 1;
    END LOOP;
  END IF;

  IF v_batch IS NOT NULL THEN
    UPDATE public.balance_import_batches
       SET status = 'applied', applied_at = now(), applied_by = j.created_by, row_count = v_rowno, valid_row_count = v_rowno,
           invalid_row_count = 0, total_delta = v_amount
     WHERE id = v_batch;
    IF v_rowno = 0 THEN   -- nothing new was credited: do not leave an empty batch in Import History
      DELETE FROM public.balance_import_batches WHERE id = v_batch;
      v_batch := NULL;
    END IF;
  END IF;

  UPDATE public.pwt_inbound_jobs
     SET status = CASE WHEN v_failed > 0 OR v_unmatched > 0 OR v_flagged > 0 THEN 'needs_attention' ELSE 'completed' END,
         completed_at = now(), imported_count = v_imported, already_imported_count = v_already, skipped_count = v_skipped,
         unmatched_count = v_unmatched, failed_count = v_failed, flagged_count = v_flagged, imported_amount = v_amount, batch_id = v_batch
   WHERE id = p_job_id;
  RETURN jsonb_build_object('imported', v_imported, 'already_imported', v_already, 'skipped', v_skipped, 'unmatched', v_unmatched,
                            'failed', v_failed, 'flagged', v_flagged, 'imported_amount', v_amount);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_inbound_finish_v1(p_connector uuid, p_job uuid, p_total integer, p_error text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.pwt_inbound_jobs%ROWTYPE; n integer;
BEGIN
  SELECT * INTO j FROM public.pwt_inbound_jobs WHERE id = p_job AND claimed_by = p_connector AND status = 'fetching' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ignored', true); END IF;
  IF p_error IS NOT NULL AND btrim(p_error) <> '' THEN
    UPDATE public.pwt_inbound_jobs SET status = 'failed', error = left(p_error, 500), completed_at = now() WHERE id = p_job;
    RETURN jsonb_build_object('failed', true);
  END IF;
  SELECT count(*) INTO n FROM public.pwt_inbound_vouchers WHERE job_id = p_job;
  IF n <> COALESCE(p_total, -1) THEN   -- never process a partial upload
    UPDATE public.pwt_inbound_jobs SET status = 'failed', completed_at = now(),
           error = 'incomplete upload: expected ' || COALESCE(p_total::text, '?') || ' vouchers, received ' || n WHERE id = p_job;
    RETURN jsonb_build_object('failed', true);
  END IF;
  UPDATE public.pwt_inbound_jobs SET status = 'processing', fetch_complete = true, vouchers_fetched = n WHERE id = p_job;
  RETURN public._pwt_inbound_process_v1(p_job);
END $$;

REVOKE ALL ON FUNCTION
  public.pwt_inbound_create_job_v1(uuid), public.pwt_inbound_list_jobs_v1(uuid, integer), public.pwt_inbound_job_problems_v1(uuid, uuid),
  public.pwt_inbound_get_settings_v1(uuid), public.pwt_inbound_set_voucher_type_v1(uuid, text),
  public.pwt_inbound_claim_v1(uuid, text), public.pwt_inbound_submit_v1(uuid, uuid, integer, jsonb, integer),
  public._pwt_inbound_process_v1(uuid), public.pwt_inbound_finish_v1(uuid, uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_inbound_create_job_v1(uuid), public.pwt_inbound_list_jobs_v1(uuid, integer),
  public.pwt_inbound_job_problems_v1(uuid, uuid), public.pwt_inbound_get_settings_v1(uuid),
  public.pwt_inbound_set_voucher_type_v1(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_inbound_claim_v1(uuid, text), public.pwt_inbound_submit_v1(uuid, uuid, integer, jsonb, integer),
  public._pwt_inbound_process_v1(uuid), public.pwt_inbound_finish_v1(uuid, uuid, integer, text) TO service_role;
