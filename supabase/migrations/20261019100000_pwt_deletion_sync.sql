-- PesoWise -> TallyPrime: automatic correction when a SYNCED expense is deleted in PesoWise ("deletion sync").
--
-- ADDITIVE and NAMESPACED (`pwt_*`). Apply manually, to the PesoWise project database only
-- (see Documentations MD/pesowise-tally-complete-guide.md, Part H). Needs 20261016120000_pwt_foundation.sql.
--
--   expense deleted (soft: expenses.deleted_at set, or hard: row removed)
--     -> trigger finds it in pwt_registry (it was posted to Tally)  -> pwt_deletion_jobs (queued)
--     -> the paired Windows connector claims the job (only while Tally's active company is the paired one)
--     -> corrects TallyPrime (delete the voucher / remove only that expense's amount / compensating reversal), reads it back
--     -> acks; the registry row is stamped removed_at and every step is written to pwt_correction_log.
--
-- An expense that was never posted has no registry row, so nothing is queued and Tally is never touched.

-- ---------------------------------------------------------------------------------------------
-- 1. Registry: remember WHICH ledgers each posting hit (needed to remove exactly one expense later)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.pwt_registry
  ADD COLUMN IF NOT EXISTS employee_ledger text,
  ADD COLUMN IF NOT EXISTS expense_ledger  text,
  ADD COLUMN IF NOT EXISTS serial          integer,
  ADD COLUMN IF NOT EXISTS removed_at      timestamptz;

CREATE INDEX IF NOT EXISTS pwt_registry_voucher_idx ON public.pwt_registry (organization_id, voucher_date, voucher_number);

-- ---------------------------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pwt_deletion_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  source_id          text NOT NULL,
  expense_id         uuid,
  transaction_number text,
  tally_company      text NOT NULL,
  voucher_number     text NOT NULL,
  voucher_date       date NOT NULL,
  serial             integer,
  amount             numeric(14, 2) NOT NULL,
  employee_ledger    text,
  expense_ledger     text,
  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'claimed', 'completed', 'blocked', 'cancelled')),
  action             text CHECK (action IS NULL OR action IN ('delete_voucher', 'alter_voucher', 'reversal_voucher', 'already_gone')),
  attempts           integer NOT NULL DEFAULT 0,
  claimed_by         uuid,
  lease_until        timestamptz,
  not_before         timestamptz,
  detected_via       text NOT NULL DEFAULT 'trigger',
  result             jsonb,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  -- ONE correction per synced expense, ever: a repeated delete, a trigger firing twice or a scan can never queue a second one.
  UNIQUE (organization_id, source_id)
);
CREATE INDEX IF NOT EXISTS pwt_deletion_jobs_claim_idx ON public.pwt_deletion_jobs (organization_id, status, created_at);

-- Append-only audit history of every correction step.
CREATE TABLE IF NOT EXISTS public.pwt_correction_log (
  id              bigserial PRIMARY KEY,
  job_id          uuid NOT NULL,
  organization_id uuid NOT NULL,
  source_id       text NOT NULL,
  event           text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pwt_correction_log_job_idx ON public.pwt_correction_log (job_id, id);

CREATE TABLE IF NOT EXISTS public.pwt_deletion_state (
  organization_id uuid PRIMARY KEY,
  last_scan_at    timestamptz NOT NULL DEFAULT 'epoch'
);

ALTER TABLE public.pwt_deletion_jobs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_correction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pwt_deletion_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pwt_deletion_jobs, public.pwt_correction_log, public.pwt_deletion_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.pwt_correction_log_id_seq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Planner now records the ledgers on every reservation (same signature as the foundation version)
-- ---------------------------------------------------------------------------------------------
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
  INSERT INTO public.pwt_registry (organization_id, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash,
                                   employee_ledger, expense_ledger, serial)
  SELECT j.organization_id, r ->> 'source_id', 'reserved', p_job_id, (r ->> 'amount')::numeric,
         r ->> 'voucher_number', (r ->> 'voucher_date')::date, r ->> 'content_hash',
         NULLIF(r ->> 'employee_ledger', ''), NULLIF(r ->> 'expense_ledger', ''), NULLIF(r ->> 'serial', '')::int
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

-- ---------------------------------------------------------------------------------------------
-- 4. One-time backfill for expenses posted BEFORE this migration (best effort; anything it cannot
--    resolve stays NULL and is handled safely at correction time: a lone-expense voucher can still
--    be deleted, anything ambiguous is BLOCKED, never guessed).
-- ---------------------------------------------------------------------------------------------
UPDATE public.pwt_registry r SET serial = v.serial
  FROM (SELECT DISTINCT ON (organization_id, voucher_date, voucher_number) organization_id, voucher_date, voucher_number, serial
          FROM public.pwt_vouchers ORDER BY organization_id, voucher_date, voucher_number) v
 WHERE r.serial IS NULL AND v.organization_id = r.organization_id AND v.voucher_date = r.voucher_date AND v.voucher_number = r.voucher_number;

UPDATE public.pwt_registry r SET expense_ledger = c.l
  FROM (SELECT r2.organization_id, r2.source_id,
               (SELECT cat ->> 'expenseLedger' FROM public.pwt_sync_jobs sj, jsonb_array_elements(COALESCE(sj.config_snapshot -> 'categories', '[]'::jsonb)) cat
                 WHERE sj.id = r2.job_id AND (cat ->> 'serial')::int = r2.serial LIMIT 1) AS l
          FROM public.pwt_registry r2 WHERE r2.expense_ledger IS NULL AND r2.serial IS NOT NULL) c
 WHERE c.l IS NOT NULL AND r.organization_id = c.organization_id AND r.source_id = c.source_id;

UPDATE public.pwt_registry r SET employee_ledger = e.l
  FROM (SELECT DISTINCT ON (x.job_id, x.eid) x.job_id, x.eid,
               COALESCE(sj.config_snapshot -> 'employeeLedgerOverrides' ->> x.code,
                        regexp_replace(btrim(x.name), '\s+', ' ', 'g') || '-' || x.code) AS l
          FROM (SELECT jr.job_id, COALESCE(jr.payload ->> 'expense_id', jr.payload ->> 'id') AS eid,
                       btrim(COALESCE(jr.payload ->> 'employee_name', jr.payload ->> 'user_name', '')) AS name,
                       btrim(COALESCE(jr.payload ->> 'employee_code', jr.payload ->> 'employee_id', '')) AS code
                  FROM public.pwt_job_rows jr) x
          JOIN public.pwt_sync_jobs sj ON sj.id = x.job_id
         WHERE x.eid IS NOT NULL AND x.name <> '' AND x.code <> '') e
 WHERE r.employee_ledger IS NULL AND e.job_id = r.job_id AND e.eid = split_part(r.source_id, ':', 3);

-- ---------------------------------------------------------------------------------------------
-- 5. Detection
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_enqueue_deletion_v1(p_org uuid, p_expense_id uuid, p_via text, p_txn text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reg public.pwt_registry%ROWTYPE; v_company text; v_id uuid; v_src text := p_org::text || ':expense:' || p_expense_id::text;
BEGIN
  SELECT * INTO reg FROM public.pwt_registry WHERE organization_id = p_org AND source_id = v_src;
  -- Never posted to Tally (no registry row), still being delivered ('reserved'), or already corrected: nothing to do.
  IF NOT FOUND OR reg.state <> 'posted' OR reg.removed_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT tally_company INTO v_company FROM public.pwt_sync_jobs WHERE id = reg.job_id;
  IF v_company IS NULL THEN
    SELECT tally_company INTO v_company FROM public.pwt_connectors WHERE organization_id = p_org AND status = 'active' ORDER BY paired_at DESC LIMIT 1;
  END IF;
  IF v_company IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.pwt_deletion_jobs (organization_id, source_id, expense_id, transaction_number, tally_company, voucher_number, voucher_date,
                                        serial, amount, employee_ledger, expense_ledger, detected_via)
  VALUES (p_org, v_src, p_expense_id, p_txn, v_company, reg.voucher_number, reg.voucher_date, reg.serial, reg.amount,
          reg.employee_ledger, reg.expense_ledger, COALESCE(p_via, 'trigger'))
  ON CONFLICT (organization_id, source_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    VALUES (v_id, p_org, v_src, 'detected', jsonb_build_object('via', COALESCE(p_via, 'trigger'), 'voucher', reg.voucher_number,
            'voucher_date', reg.voucher_date, 'amount', reg.amount, 'transaction_number', p_txn));
  END IF;
  RETURN v_id;
END $$;

-- Fires after an expense is soft-deleted (deleted_at set) or physically deleted. It must NEVER block or fail the deletion
-- itself: any error is swallowed (a warning is logged) and the periodic scan below catches anything the trigger missed.
CREATE OR REPLACE FUNCTION public.pwt_expense_deleted_trg_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_id uuid; v_txn text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      v_org := OLD.organization_id; v_id := OLD.id; v_txn := to_jsonb(OLD) ->> 'transaction_number';
    ELSE
      v_org := NEW.organization_id; v_id := NEW.id; v_txn := to_jsonb(NEW) ->> 'transaction_number';
    END IF;
    IF v_org IS NOT NULL AND EXISTS (SELECT 1 FROM public.pwt_registry
                                      WHERE organization_id = v_org AND source_id = v_org::text || ':expense:' || v_id::text
                                        AND state = 'posted' AND removed_at IS NULL) THEN
      PERFORM public.pwt_enqueue_deletion_v1(v_org, v_id, 'trigger', v_txn);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pwt deletion detection failed for expense %: %', COALESCE(v_id::text, '?'), SQLERRM;
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pwt_expense_soft_deleted ON public.expenses;
CREATE TRIGGER pwt_expense_soft_deleted AFTER UPDATE OF deleted_at ON public.expenses
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.pwt_expense_deleted_trg_v1();
DROP TRIGGER IF EXISTS pwt_expense_hard_deleted ON public.expenses;
CREATE TRIGGER pwt_expense_hard_deleted AFTER DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.pwt_expense_deleted_trg_v1();

-- Safety net (a deletion made while the trigger was missing, a failed trigger, a restore of an old backup): every posted
-- registry row whose expense is deleted or gone and that has no correction yet is queued. Idempotent.
CREATE OR REPLACE FUNCTION public.pwt_deletion_scan_v1(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT split_part(g.source_id, ':', 3)::uuid AS eid, e.deleted_at, to_jsonb(e) ->> 'transaction_number' AS txn
      FROM public.pwt_registry g
      LEFT JOIN public.expenses e ON e.organization_id = g.organization_id AND e.id = split_part(g.source_id, ':', 3)::uuid
     WHERE g.organization_id = p_org AND g.state = 'posted' AND g.removed_at IS NULL
       AND g.source_id ~ '^[0-9a-fA-F-]{36}:expense:[0-9a-fA-F-]{36}$'
       AND (e.id IS NULL OR e.deleted_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.pwt_deletion_jobs d WHERE d.organization_id = g.organization_id AND d.source_id = g.source_id)
  LOOP
    IF public.pwt_enqueue_deletion_v1(p_org, r.eid, 'scan', r.txn) IS NOT NULL THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Connector: claim and acknowledge  (service role; the edge function authenticates the device token)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_deletion_claim_v1(p_connector uuid, p_active_company text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pwt_connectors%ROWTYPE; j public.pwt_deletion_jobs%ROWTYPE; v_run boolean; v_cfg jsonb; v_known numeric; v_sib integer; v_rev boolean;
BEGIN
  SELECT * INTO c FROM public.pwt_connectors WHERE id = p_connector AND status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Safety-net scan, at most every 5 minutes per organisation.
  INSERT INTO public.pwt_deletion_state (organization_id, last_scan_at) VALUES (c.organization_id, now())
  ON CONFLICT (organization_id) DO UPDATE SET last_scan_at = now() WHERE public.pwt_deletion_state.last_scan_at < now() - interval '5 minutes'
  RETURNING true INTO v_run;
  IF v_run THEN PERFORM public.pwt_deletion_scan_v1(c.organization_id); END IF;

  -- A connector that died mid-job: its lease expires and the job becomes claimable again.
  UPDATE public.pwt_deletion_jobs SET status = 'queued', claimed_by = NULL, lease_until = NULL
   WHERE organization_id = c.organization_id AND status = 'claimed' AND lease_until < now();

  LOOP
    SELECT d.* INTO j FROM public.pwt_deletion_jobs d
     WHERE d.organization_id = c.organization_id AND d.status = 'queued' AND d.tally_company = c.tally_company
       AND (d.not_before IS NULL OR d.not_before <= now())
       -- two corrections to the SAME voucher never run at once
       AND NOT EXISTS (SELECT 1 FROM public.pwt_deletion_jobs o
                        WHERE o.organization_id = d.organization_id AND o.status = 'claimed' AND o.id <> d.id
                          AND o.voucher_number = d.voucher_number AND o.voucher_date = d.voucher_date)
     ORDER BY d.created_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF p_active_company IS DISTINCT FROM c.tally_company THEN
      UPDATE public.pwt_connectors SET last_error = 'Active Tally company does not match the paired company' WHERE id = p_connector;
      RETURN jsonb_build_object('blocked', 'wrong_company', 'expected', c.tally_company);
    END IF;

    -- Re-check the premise: if the expense was restored in the meantime there is nothing to correct.
    IF j.expense_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = j.expense_id AND e.deleted_at IS NULL) THEN
      UPDATE public.pwt_deletion_jobs SET status = 'cancelled', completed_at = now(), error = 'expense is active again (restored)' WHERE id = j.id;
      INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
      VALUES (j.id, j.organization_id, j.source_id, 'cancelled', jsonb_build_object('reason', 'expense restored'));
      CONTINUE;
    END IF;

    UPDATE public.pwt_deletion_jobs SET status = 'claimed', claimed_by = p_connector, attempts = attempts + 1,
           lease_until = now() + interval '3 minutes' WHERE id = j.id RETURNING * INTO j;

    SELECT config INTO v_cfg FROM public.pwt_mapping_config WHERE organization_id = j.organization_id;
    SELECT total INTO v_known FROM public.pwt_vouchers
     WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_date = j.voucher_date AND voucher_number = j.voucher_number;
    SELECT count(*) INTO v_sib FROM public.pwt_registry g
     WHERE g.organization_id = j.organization_id AND g.voucher_number = j.voucher_number AND g.voucher_date = j.voucher_date
       AND g.state = 'posted' AND g.removed_at IS NULL AND g.source_id <> j.source_id;
    -- Once a voucher has been corrected by a compensating reversal it is never deleted or altered again.
    SELECT EXISTS (SELECT 1 FROM public.pwt_deletion_jobs o
                    WHERE o.organization_id = j.organization_id AND o.voucher_number = j.voucher_number AND o.voucher_date = j.voucher_date
                      AND o.status = 'completed' AND o.action = 'reversal_voucher') INTO v_rev;
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    VALUES (j.id, j.organization_id, j.source_id, 'claimed', jsonb_build_object('attempt', j.attempts, 'connector', p_connector));

    RETURN jsonb_build_object(
      'job_id', j.id, 'tally_company', j.tally_company, 'voucher_number', j.voucher_number, 'voucher_date', j.voucher_date,
      'amount', j.amount, 'employee_ledger', j.employee_ledger, 'expense_ledger', j.expense_ledger, 'serial', j.serial,
      'transaction_number', j.transaction_number, 'known_total', v_known, 'siblings', v_sib, 'force_reversal', v_rev,
      'voucher_type', COALESCE(v_cfg ->> 'voucherType', 'Journal'), 'expense_side', COALESCE(v_cfg ->> 'expenseSide', 'debit'),
      'narration_tag', 'PWT', 'attempt', j.attempts);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.pwt_deletion_ack_v1(
  p_connector uuid, p_job uuid, p_outcome text, p_action text, p_result jsonb, p_error text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.pwt_deletion_jobs%ROWTYPE; v_offline boolean := COALESCE(p_result ->> 'offline', 'false') = 'true';
BEGIN
  IF p_outcome NOT IN ('completed', 'blocked', 'retry') THEN RAISE EXCEPTION 'unknown outcome' USING ERRCODE = '22023'; END IF;
  SELECT * INTO j FROM public.pwt_deletion_jobs WHERE id = p_job AND claimed_by = p_connector AND status = 'claimed' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ignored', true); END IF;   -- repeated / stale ack: harmless

  IF p_outcome = 'completed' THEN
    IF p_action IS NULL OR p_action NOT IN ('delete_voucher', 'alter_voucher', 'reversal_voucher', 'already_gone') THEN
      RAISE EXCEPTION 'completed needs a valid action' USING ERRCODE = '22023';
    END IF;
    UPDATE public.pwt_deletion_jobs SET status = 'completed', action = p_action, result = p_result, error = NULL,
           completed_at = now(), claimed_by = NULL, lease_until = NULL WHERE id = j.id;
    UPDATE public.pwt_registry SET removed_at = now(), updated_at = now() WHERE organization_id = j.organization_id AND source_id = j.source_id;
    IF p_action = 'alter_voucher' THEN
      UPDATE public.pwt_vouchers SET total = GREATEST(total - j.amount, 0)
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_date = j.voucher_date AND voucher_number = j.voucher_number;
    ELSIF p_action = 'delete_voucher' THEN
      UPDATE public.pwt_vouchers SET total = 0
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_date = j.voucher_date AND voucher_number = j.voucher_number;
    END IF;
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    VALUES (j.id, j.organization_id, j.source_id, 'completed', jsonb_build_object('action', p_action) || COALESCE(p_result, '{}'::jsonb));
    RETURN jsonb_build_object('completed', true, 'action', p_action);
  END IF;

  IF p_outcome = 'blocked' OR (j.attempts >= 5 AND NOT v_offline) THEN
    UPDATE public.pwt_deletion_jobs SET status = 'blocked', result = p_result, completed_at = now(), claimed_by = NULL, lease_until = NULL,
           error = left(COALESCE(p_error, 'blocked'), 1000) WHERE id = j.id;
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    VALUES (j.id, j.organization_id, j.source_id, 'blocked', jsonb_build_object('error', left(COALESCE(p_error, ''), 500)));
    RETURN jsonb_build_object('blocked', true);
  END IF;

  -- Transient (Tally closed, a failed attempt): requeue with backoff. A Tally outage refunds the attempt so it never exhausts retries.
  UPDATE public.pwt_deletion_jobs SET status = 'queued', claimed_by = NULL, lease_until = NULL, result = p_result,
         error = left(COALESCE(p_error, ''), 1000),
         attempts = CASE WHEN v_offline THEN GREATEST(attempts - 1, 0) ELSE attempts END,
         not_before = now() + (CASE WHEN v_offline THEN 1 ELSE j.attempts END) * interval '30 seconds' WHERE id = j.id;
  INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
  VALUES (j.id, j.organization_id, j.source_id, 'retry', jsonb_build_object('offline', v_offline, 'error', left(COALESCE(p_error, ''), 500)));
  RETURN jsonb_build_object('retry', true);
END $$;

-- ---------------------------------------------------------------------------------------------
-- 7. Admin / UI  (authenticated, admin-checked)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_list_deletions_v1(p_organization_id uuid, p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
    SELECT id, transaction_number, voucher_number, voucher_date, amount, employee_ledger, status, action, attempts, error,
           detected_via, created_at, completed_at
      FROM public.pwt_deletion_jobs WHERE organization_id = p_organization_id
     ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 100)) x), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_deletion_log_v1(p_organization_id uuid, p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('event', event, 'detail', detail, 'at', at) ORDER BY id)
                     FROM public.pwt_correction_log WHERE organization_id = p_organization_id AND job_id = p_job), '[]'::jsonb);
END $$;

-- A blocked correction can be retried (for example after the accountant fixed the voucher in Tally). Never needed in the normal flow.
CREATE OR REPLACE FUNCTION public.pwt_retry_deletion_v1(p_organization_id uuid, p_job uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  UPDATE public.pwt_deletion_jobs SET status = 'queued', attempts = 0, not_before = NULL, error = NULL, completed_at = NULL
   WHERE id = p_job AND organization_id = p_organization_id AND status = 'blocked';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    SELECT id, organization_id, source_id, 'retry_requested', jsonb_build_object('by', auth.uid()) FROM public.pwt_deletion_jobs WHERE id = p_job;
  END IF;
  RETURN n = 1;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.pwt_enqueue_deletion_v1(uuid, uuid, text, text), public.pwt_expense_deleted_trg_v1(), public.pwt_deletion_scan_v1(uuid),
  public.pwt_deletion_claim_v1(uuid, text), public.pwt_deletion_ack_v1(uuid, uuid, text, text, jsonb, text),
  public.pwt_list_deletions_v1(uuid, integer), public.pwt_deletion_log_v1(uuid, uuid), public.pwt_retry_deletion_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.pwt_enqueue_deletion_v1(uuid, uuid, text, text), public.pwt_deletion_scan_v1(uuid),
  public.pwt_deletion_claim_v1(uuid, text), public.pwt_deletion_ack_v1(uuid, uuid, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION
  public.pwt_list_deletions_v1(uuid, integer), public.pwt_deletion_log_v1(uuid, uuid), public.pwt_retry_deletion_v1(uuid, uuid) TO authenticated;
