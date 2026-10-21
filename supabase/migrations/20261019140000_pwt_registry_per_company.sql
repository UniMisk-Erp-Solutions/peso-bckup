-- PesoWise -> TallyPrime: the "already posted" record is kept PER TALLY COMPANY.
--
-- Before: pwt_registry was keyed by (organization, expense), so an expense posted to one Tally company counted as "already in
-- Tally" for every other company of the same organisation, and a new, empty company was never filled.
-- After:  keyed by (organization, tally company, expense). Each company keeps its own history; the same expense can be posted
-- once to each company; duplicates inside one company are still impossible.
--
-- ADDITIVE and idempotent. Existing rows are tagged with the company their sync job posted to. Apply manually, PesoWise DB only.
-- Needs 20261016120000_pwt_foundation.sql and 20261019100000_pwt_deletion_sync.sql.

-- ---------------------------------------------------------------------------------------------
-- 1. Registry: company column, backfill, new primary key
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.pwt_registry ADD COLUMN IF NOT EXISTS tally_company text;

UPDATE public.pwt_registry r SET tally_company = j.tally_company
  FROM public.pwt_sync_jobs j WHERE r.tally_company IS NULL AND j.id = r.job_id;
-- a row whose job no longer exists: attribute it to the organisation's first paired company (never leave it unattributed)
UPDATE public.pwt_registry r SET tally_company = (
    SELECT c.tally_company FROM public.pwt_connectors c WHERE c.organization_id = r.organization_id ORDER BY c.paired_at ASC LIMIT 1)
 WHERE r.tally_company IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pwt_registry WHERE tally_company IS NULL) THEN
    RAISE EXCEPTION 'pwt_registry has rows with no Tally company; resolve them before applying this migration';
  END IF;
  ALTER TABLE public.pwt_registry ALTER COLUMN tally_company SET NOT NULL;
  IF (SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'public.pwt_registry'::regclass AND c.contype = 'p') IS DISTINCT FROM ARRAY['organization_id', 'tally_company', 'source_id'] THEN
    ALTER TABLE public.pwt_registry DROP CONSTRAINT pwt_registry_pkey;
    ALTER TABLE public.pwt_registry ADD PRIMARY KEY (organization_id, tally_company, source_id);
  END IF;
END $$;

-- one correction per expense PER COMPANY
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pwt_deletion_jobs'::regclass AND conname = 'pwt_deletion_jobs_organization_id_source_id_key') THEN
    ALTER TABLE public.pwt_deletion_jobs DROP CONSTRAINT pwt_deletion_jobs_organization_id_source_id_key;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS pwt_deletion_jobs_company_source_uidx ON public.pwt_deletion_jobs (organization_id, tally_company, source_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Planner state: "posted" is now what THIS company already has
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_registry_state_v1(p_org uuid, p_tally_company text, p_source_ids text[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'posted', COALESCE((SELECT jsonb_object_agg(source_id, amount) FROM public.pwt_registry
                         WHERE organization_id = p_org AND tally_company = p_tally_company AND source_id = ANY (p_source_ids)), '{}'::jsonb),
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

  -- Reserve registry rows FOR THIS COMPANY. A conflict means another job claimed the same expense for the same company first.
  INSERT INTO public.pwt_registry (organization_id, tally_company, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash,
                                   employee_ledger, expense_ledger, serial)
  SELECT j.organization_id, j.tally_company, r ->> 'source_id', 'reserved', p_job_id, (r ->> 'amount')::numeric,
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
-- 3. Deletion sync: one correction per company the expense was posted to
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pwt_enqueue_deletion_v1(p_org uuid, p_expense_id uuid, p_via text, p_txn text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reg public.pwt_registry%ROWTYPE; v_id uuid; v_last uuid; v_src text := p_org::text || ':expense:' || p_expense_id::text;
BEGIN
  -- Every Tally company this expense was posted to gets its own correction. Never posted, still being delivered ('reserved') or already
  -- corrected rows are skipped.
  FOR reg IN SELECT * FROM public.pwt_registry
              WHERE organization_id = p_org AND source_id = v_src AND state = 'posted' AND removed_at IS NULL
  LOOP
    INSERT INTO public.pwt_deletion_jobs (organization_id, source_id, expense_id, transaction_number, tally_company, voucher_number, voucher_date,
                                          serial, amount, employee_ledger, expense_ledger, detected_via)
    VALUES (p_org, v_src, p_expense_id, p_txn, reg.tally_company, reg.voucher_number, reg.voucher_date, reg.serial, reg.amount,
            reg.employee_ledger, reg.expense_ledger, COALESCE(p_via, 'trigger'))
    ON CONFLICT (organization_id, tally_company, source_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_last := v_id;
      INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
      VALUES (v_id, p_org, v_src, 'detected', jsonb_build_object('via', COALESCE(p_via, 'trigger'), 'company', reg.tally_company,
              'voucher', reg.voucher_number, 'voucher_date', reg.voucher_date, 'amount', reg.amount, 'transaction_number', p_txn));
    END IF;
  END LOOP;
  RETURN v_last;
END $$;

CREATE OR REPLACE FUNCTION public.pwt_deletion_scan_v1(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT split_part(g.source_id, ':', 3)::uuid AS eid, e.deleted_at, to_jsonb(e) ->> 'transaction_number' AS txn
      FROM public.pwt_registry g
      LEFT JOIN public.expenses e ON e.organization_id = g.organization_id AND e.id = split_part(g.source_id, ':', 3)::uuid
     WHERE g.organization_id = p_org AND g.state = 'posted' AND g.removed_at IS NULL
       AND g.source_id ~ '^[0-9a-fA-F-]{36}:expense:[0-9a-fA-F-]{36}$'
       AND (e.id IS NULL OR e.deleted_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.pwt_deletion_jobs d
                        WHERE d.organization_id = g.organization_id AND d.tally_company = g.tally_company AND d.source_id = g.source_id)
  LOOP
    IF public.pwt_enqueue_deletion_v1(p_org, r.eid, 'scan', r.txn) IS NOT NULL THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.pwt_deletion_claim_v1(p_connector uuid, p_active_company text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pwt_connectors%ROWTYPE; j public.pwt_deletion_jobs%ROWTYPE; v_run boolean; v_cfg jsonb; v_known numeric; v_sib integer; v_rev boolean;
BEGIN
  SELECT * INTO c FROM public.pwt_connectors WHERE id = p_connector AND status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO public.pwt_deletion_state (organization_id, last_scan_at) VALUES (c.organization_id, now())
  ON CONFLICT (organization_id) DO UPDATE SET last_scan_at = now() WHERE public.pwt_deletion_state.last_scan_at < now() - interval '5 minutes'
  RETURNING true INTO v_run;
  IF v_run THEN PERFORM public.pwt_deletion_scan_v1(c.organization_id); END IF;

  UPDATE public.pwt_deletion_jobs SET status = 'queued', claimed_by = NULL, lease_until = NULL
   WHERE organization_id = c.organization_id AND status = 'claimed' AND lease_until < now();

  LOOP
    SELECT d.* INTO j FROM public.pwt_deletion_jobs d
     WHERE d.organization_id = c.organization_id AND d.status = 'queued' AND d.tally_company = c.tally_company
       AND (d.not_before IS NULL OR d.not_before <= now())
       AND NOT EXISTS (SELECT 1 FROM public.pwt_deletion_jobs o
                        WHERE o.organization_id = d.organization_id AND o.tally_company = d.tally_company AND o.status = 'claimed' AND o.id <> d.id
                          AND o.voucher_number = d.voucher_number AND o.voucher_date = d.voucher_date)
     ORDER BY d.created_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF p_active_company IS DISTINCT FROM c.tally_company THEN
      UPDATE public.pwt_connectors SET last_error = 'Active Tally company does not match the paired company' WHERE id = p_connector;
      RETURN jsonb_build_object('blocked', 'wrong_company', 'expected', c.tally_company);
    END IF;

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
     WHERE g.organization_id = j.organization_id AND g.tally_company = j.tally_company AND g.voucher_number = j.voucher_number
       AND g.voucher_date = j.voucher_date AND g.state = 'posted' AND g.removed_at IS NULL AND g.source_id <> j.source_id;
    SELECT EXISTS (SELECT 1 FROM public.pwt_deletion_jobs o
                    WHERE o.organization_id = j.organization_id AND o.tally_company = j.tally_company AND o.voucher_number = j.voucher_number
                      AND o.voucher_date = j.voucher_date AND o.status = 'completed' AND o.action = 'reversal_voucher') INTO v_rev;
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
  IF NOT FOUND THEN RETURN jsonb_build_object('ignored', true); END IF;

  IF p_outcome = 'completed' THEN
    IF p_action IS NULL OR p_action NOT IN ('delete_voucher', 'alter_voucher', 'reversal_voucher', 'already_gone') THEN
      RAISE EXCEPTION 'completed needs a valid action' USING ERRCODE = '22023';
    END IF;
    UPDATE public.pwt_deletion_jobs SET status = 'completed', action = p_action, result = p_result, error = NULL,
           completed_at = now(), claimed_by = NULL, lease_until = NULL WHERE id = j.id;
    UPDATE public.pwt_registry SET removed_at = now(), updated_at = now()
     WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND source_id = j.source_id;
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

  UPDATE public.pwt_deletion_jobs SET status = 'queued', claimed_by = NULL, lease_until = NULL, result = p_result,
         error = left(COALESCE(p_error, ''), 1000),
         attempts = CASE WHEN v_offline THEN GREATEST(attempts - 1, 0) ELSE attempts END,
         not_before = now() + (CASE WHEN v_offline THEN 1 ELSE j.attempts END) * interval '30 seconds' WHERE id = j.id;
  INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
  VALUES (j.id, j.organization_id, j.source_id, 'retry', jsonb_build_object('offline', v_offline, 'error', left(COALESCE(p_error, ''), 500)));
  RETURN jsonb_build_object('retry', true);
END $$;

REVOKE ALL ON FUNCTION
  public.pwt_registry_state_v1(uuid, text, text[]), public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.pwt_enqueue_deletion_v1(uuid, uuid, text, text), public.pwt_deletion_scan_v1(uuid),
  public.pwt_deletion_claim_v1(uuid, text), public.pwt_deletion_ack_v1(uuid, uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.pwt_registry_state_v1(uuid, text, text[]), public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.pwt_enqueue_deletion_v1(uuid, uuid, text, text), public.pwt_deletion_scan_v1(uuid),
  public.pwt_deletion_claim_v1(uuid, text), public.pwt_deletion_ack_v1(uuid, uuid, text, text, jsonb, text) TO service_role;
