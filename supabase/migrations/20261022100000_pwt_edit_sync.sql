-- PesoWise -> TallyPrime: automatic correction in Tally when an already-synced expense is EDITED in PesoWise (amount, month, employee or category).
-- Edit = (1) correct the OLD posting in Tally with the existing deletion engine (delete / reduce / reversal), (2) post the expense's CURRENT version.
--   * a trigger on public.expenses marks synced expenses that were updated ('dirty');
--   * the planner (any Detailed Expense sync, manual or automatic) compares each already-posted expense with what was recorded when it was posted;
--   * a changed one queues an 'edited' correction in pwt_deletion_jobs (same connector, same safety rules as a deletion);
--   * when that correction completes, the registry row is dropped and the expense is queued 'repost';
--   * pwt_edit_job_v1 (called from the connector heartbeat) starts an automatic job that looks at ONLY the queued expenses.
-- Replaces pwt_complete_prep_v1 (one more optional argument), pwt_registry_state_v1, pwt_deletion_claim_v1 and pwt_deletion_ack_v1; adds columns and one table.

ALTER TABLE public.pwt_registry ADD COLUMN IF NOT EXISTS expense_type text;
ALTER TABLE public.pwt_deletion_jobs ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'deleted';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pwt_deletion_jobs'::regclass AND conname = 'pwt_deletion_jobs_reason_chk') THEN
    ALTER TABLE public.pwt_deletion_jobs ADD CONSTRAINT pwt_deletion_jobs_reason_chk CHECK (reason IN ('deleted', 'edited'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.pwt_edit_queue (
  organization_id uuid NOT NULL,
  tally_company   text NOT NULL,
  source_id       text NOT NULL,
  state           text NOT NULL CHECK (state IN ('dirty', 'correcting', 'repost')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, tally_company, source_id)
);
ALTER TABLE public.pwt_edit_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pwt_edit_queue FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS pwt_edit_queue_state_idx ON public.pwt_edit_queue (organization_id, tally_company, state, updated_at);

-- A previous 6-argument version would make a call without p_edits ambiguous.
DROP FUNCTION IF EXISTS public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.pwt_enqueue_edit_v1(p_org uuid, p_company text, p_source_id text, p_edit jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE reg public.pwt_registry%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO reg FROM public.pwt_registry
   WHERE organization_id = p_org AND tally_company = p_company AND source_id = p_source_id AND state = 'posted' AND removed_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.pwt_deletion_jobs (organization_id, source_id, expense_id, tally_company, voucher_number, voucher_date,
                                        serial, amount, employee_ledger, expense_ledger, detected_via, reason)
  VALUES (p_org, p_source_id, split_part(p_source_id, ':', 3)::uuid, p_company, reg.voucher_number, reg.voucher_date,
          reg.serial, reg.amount, reg.employee_ledger, reg.expense_ledger, 'edit', 'edited')
  ON CONFLICT (organization_id, tally_company, source_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    VALUES (v_id, p_org, p_source_id, 'detected', jsonb_build_object('via', 'edit', 'company', p_company, 'voucher', reg.voucher_number,
            'voucher_date', reg.voucher_date, 'amount', reg.amount, 'changed', p_edit -> 'changed', 'was', p_edit -> 'was', 'now', p_edit -> 'now'));
    INSERT INTO public.pwt_edit_queue (organization_id, tally_company, source_id, state)
    VALUES (p_org, p_company, p_source_id, 'correcting')
    ON CONFLICT (organization_id, tally_company, source_id) DO UPDATE SET state = 'correcting', updated_at = now();
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pwt_complete_prep_v1(
  p_job_id uuid, p_worker text, p_batches jsonb, p_reservations jsonb, p_vouchers jsonb, p_summary jsonb, p_edits jsonb DEFAULT '[]'::jsonb
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
      FROM jsonb_array_elements(COALESCE(p_vouchers -> (b ->> 'seq'), '[]'::jsonb)) x
    -- A voucher that a failed sync released can be planned again (same date and number); a planned or posted one is never overwritten.
    ON CONFLICT (organization_id, tally_company, voucher_date, voucher_number) DO UPDATE
      SET serial = EXCLUDED.serial, batch_id = EXCLUDED.batch_id, total = EXCLUDED.total, status = 'planned'
      WHERE public.pwt_vouchers.status = 'released';
    -- Same protection as before: if any voucher of this batch is already planned or posted by another sync, fail loudly.
    IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(p_vouchers -> (b ->> 'seq'), '[]'::jsonb))) <>
       (SELECT count(*) FROM public.pwt_vouchers WHERE batch_id = v_batch) THEN
      RAISE EXCEPTION 'duplicate voucher: a planned or posted voucher with the same date and number already exists' USING ERRCODE = '23505';
    END IF;
  END LOOP;

  -- Expenses edited after they were posted: queue a correction of the OLD posting (they are re-posted once it is done).
  PERFORM public.pwt_enqueue_edit_v1(j.organization_id, j.tally_company, e ->> 'source_id', e)
    FROM jsonb_array_elements(COALESCE(p_edits, '[]'::jsonb)) e;

  -- Reserve registry rows FOR THIS COMPANY. A conflict means another job claimed the same expense for the same company first.
  INSERT INTO public.pwt_registry (organization_id, tally_company, source_id, state, job_id, amount, voucher_number, voucher_date, content_hash,
                                   employee_ledger, expense_ledger, serial, expense_type)
  SELECT j.organization_id, j.tally_company, r ->> 'source_id', 'reserved', p_job_id, (r ->> 'amount')::numeric,
         r ->> 'voucher_number', (r ->> 'voucher_date')::date, r ->> 'content_hash',
         NULLIF(r ->> 'employee_ledger', ''), NULLIF(r ->> 'expense_ledger', ''), NULLIF(r ->> 'serial', '')::int, NULLIF(r ->> 'expense_type', '')
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
  -- An automatic edit job looked at exactly the expenses it was given: those that turned out unchanged, or were just re-posted, leave the queue.
  IF jsonb_typeof(j.parameters -> 'only_source_ids') = 'array' THEN
    DELETE FROM public.pwt_edit_queue q
     WHERE q.organization_id = j.organization_id AND q.tally_company = j.tally_company AND q.state IN ('dirty', 'repost')
       AND q.source_id IN (SELECT jsonb_array_elements_text(j.parameters -> 'only_source_ids'));
  END IF;
  RETURN jsonb_build_object('batches', (SELECT count(*) FROM public.pwt_batches WHERE job_id = p_job_id), 'edits', jsonb_array_length(COALESCE(p_edits, '[]'::jsonb)));
END $$;

CREATE OR REPLACE FUNCTION public.pwt_registry_state_v1(p_org uuid, p_tally_company text, p_source_ids text[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'posted', COALESCE((SELECT jsonb_object_agg(source_id, amount) FROM public.pwt_registry
                         WHERE organization_id = p_org AND tally_company = p_tally_company AND source_id = ANY (p_source_ids)), '{}'::jsonb),
    'info', COALESCE((SELECT jsonb_object_agg(source_id, jsonb_build_object(
                'amount', amount, 'month', to_char(voucher_date, 'YYYY-MM'),
                'code', substring(employee_ledger from '-([^-]*)$'), 'type', expense_type)) FROM public.pwt_registry
                       WHERE organization_id = p_org AND tally_company = p_tally_company AND source_id = ANY (p_source_ids)
                         AND state = 'posted' AND removed_at IS NULL), '{}'::jsonb),
    'voucher_counts', COALESCE((SELECT jsonb_object_agg(k, c) FROM (
        SELECT voucher_date::text || '|' || serial::text AS k, count(*) AS c
          FROM public.pwt_vouchers
         WHERE organization_id = p_org AND tally_company = p_tally_company AND status <> 'released'
         GROUP BY 1) t), '{}'::jsonb));
$$;

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

    IF j.reason <> 'edited' AND j.expense_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = j.expense_id AND e.deleted_at IS NULL) THEN
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
      'transaction_number', j.transaction_number, 'reason', j.reason, 'known_total', v_known, 'siblings', v_sib, 'force_reversal', v_rev,
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
    IF j.reason = 'edited' THEN
      -- The old posting is corrected in Tally. Drop its registry row so the NEXT sync posts the expense's current version.
      DELETE FROM public.pwt_registry
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND source_id = j.source_id;
    ELSE
      UPDATE public.pwt_registry SET removed_at = now(), updated_at = now()
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND source_id = j.source_id;
    END IF;
    IF p_action = 'alter_voucher' THEN
      UPDATE public.pwt_vouchers SET total = GREATEST(total - j.amount, 0)
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_date = j.voucher_date AND voucher_number = j.voucher_number;
    ELSIF p_action = 'delete_voucher' THEN
      UPDATE public.pwt_vouchers SET total = 0
       WHERE organization_id = j.organization_id AND tally_company = j.tally_company AND voucher_date = j.voucher_date AND voucher_number = j.voucher_number;
    END IF;
    INSERT INTO public.pwt_correction_log (job_id, organization_id, source_id, event, detail)
    VALUES (j.id, j.organization_id, j.source_id, 'completed', jsonb_build_object('action', p_action) || COALESCE(p_result, '{}'::jsonb));
    IF j.reason = 'edited' THEN
      -- free the unique key so a later edit of the same expense can be corrected again; the history row keeps its job id
      UPDATE public.pwt_deletion_jobs SET source_id = source_id || '#edit:' || id::text WHERE id = j.id;
      INSERT INTO public.pwt_edit_queue (organization_id, tally_company, source_id, state)
      VALUES (j.organization_id, j.tally_company, j.source_id, 'repost')
      ON CONFLICT (organization_id, tally_company, source_id) DO UPDATE SET state = 'repost', updated_at = now();
    END IF;
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

-- Mark a synced expense 'dirty' when it is updated (never blocks or fails the update itself).
CREATE OR REPLACE FUNCTION public.pwt_expense_edited_trg_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.deleted_at IS NULL THEN
      INSERT INTO public.pwt_edit_queue (organization_id, tally_company, source_id, state)
      SELECT g.organization_id, g.tally_company, g.source_id, 'dirty'
        FROM public.pwt_registry g
       WHERE g.organization_id = NEW.organization_id AND g.source_id = NEW.organization_id::text || ':expense:' || NEW.id::text
         AND g.state = 'posted' AND g.removed_at IS NULL
      ON CONFLICT (organization_id, tally_company, source_id) DO UPDATE SET updated_at = now()
        WHERE public.pwt_edit_queue.state = 'dirty';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pwt edit trigger failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pwt_expense_edited ON public.expenses;
CREATE TRIGGER pwt_expense_edited AFTER UPDATE ON public.expenses
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.pwt_expense_edited_trg_v1();

-- Called from the connector heartbeat. Returns the automatic edit job that needs work (creating it when edits are waiting), else NULL.
-- Never starts while another sync of this company is running, waits 20 s after the last edit so a burst of edits is one job, and
-- never creates more than one job per minute.
CREATE OR REPLACE FUNCTION public.pwt_edit_job_v1(p_connector uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.pwt_connectors%ROWTYPE; v_ids text[]; v_base jsonb; v_params jsonb; v_job uuid; v_from date; v_to date;
BEGIN
  SELECT * INTO c FROM public.pwt_connectors WHERE id = p_connector AND status = 'active';
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT id INTO v_job FROM public.pwt_sync_jobs
   WHERE organization_id = c.organization_id AND tally_company = c.tally_company AND status IN ('queued', 'preparing')
     AND COALESCE(parameters ->> 'auto', 'false') = 'true' ORDER BY created_at LIMIT 1;
  IF v_job IS NOT NULL THEN RETURN jsonb_build_object('job_id', v_job, 'started', false); END IF;

  IF EXISTS (SELECT 1 FROM public.pwt_sync_jobs WHERE organization_id = c.organization_id AND tally_company = c.tally_company
              AND status IN ('queued', 'preparing', 'delivering')) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.pwt_sync_jobs WHERE organization_id = c.organization_id AND tally_company = c.tally_company
              AND COALESCE(parameters ->> 'auto', 'false') = 'true' AND created_at > now() - interval '1 minute') THEN RETURN NULL; END IF;

  SELECT array_agg(source_id) INTO v_ids FROM (
    SELECT source_id FROM public.pwt_edit_queue
     WHERE organization_id = c.organization_id AND tally_company = c.tally_company AND state IN ('dirty', 'repost')
       AND updated_at < now() - interval '20 seconds'
     ORDER BY updated_at LIMIT 500) q;
  IF v_ids IS NULL THEN RETURN NULL; END IF;

  -- Same report range as the organisation's last real sync for this company (falls back to the span of what was posted).
  SELECT parameters INTO v_base FROM public.pwt_sync_jobs
   WHERE organization_id = c.organization_id AND tally_company = c.tally_company AND report_type = 'detailed_expense'
     AND status = 'completed' AND COALESCE(parameters ->> 'auto', 'false') <> 'true' ORDER BY created_at DESC LIMIT 1;
  IF v_base IS NULL OR NOT (v_base ? 'date_from' OR v_base ? 'date_to' OR v_base ? 'year') THEN
    SELECT date_trunc('month', min(voucher_date))::date, (date_trunc('year', max(voucher_date)) + interval '2 years' - interval '1 day')::date
      INTO v_from, v_to FROM public.pwt_registry WHERE organization_id = c.organization_id AND tally_company = c.tally_company;
    v_base := jsonb_build_object('date_from', v_from, 'date_to', v_to);
  END IF;
  v_params := (v_base - 'only_source_ids' - 'auto') || jsonb_build_object('auto', true, 'only_source_ids', to_jsonb(v_ids));

  INSERT INTO public.pwt_sync_jobs (organization_id, report_type, parameters, parameters_hash, tally_company)
  VALUES (c.organization_id, 'detailed_expense', v_params, md5(v_params::text), c.tally_company)
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'started', true, 'expenses', array_length(v_ids, 1));
END $$;

REVOKE ALL ON FUNCTION
  public.pwt_enqueue_edit_v1(uuid, text, text, jsonb), public.pwt_edit_job_v1(uuid), public.pwt_expense_edited_trg_v1(),
  public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb), public.pwt_registry_state_v1(uuid, text, text[]),
  public.pwt_deletion_claim_v1(uuid, text), public.pwt_deletion_ack_v1(uuid, uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.pwt_enqueue_edit_v1(uuid, text, text, jsonb), public.pwt_edit_job_v1(uuid),
  public.pwt_complete_prep_v1(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb), public.pwt_registry_state_v1(uuid, text, text[]),
  public.pwt_deletion_claim_v1(uuid, text), public.pwt_deletion_ack_v1(uuid, uuid, text, text, jsonb, text) TO service_role;

-- Best-effort backfill of the expense type for expenses posted before it was recorded (from the stored report rows of the job that posted them).
-- Anything it cannot resolve stays NULL: amount, month and employee edits are still detected, category edits are not.
UPDATE public.pwt_registry g
   SET expense_type = COALESCE(NULLIF(btrim(r.payload ->> 'category'), ''), 'N/A')
  FROM public.pwt_job_rows r
 WHERE g.expense_type IS NULL AND g.job_id IS NOT NULL AND r.job_id = g.job_id
   AND r.payload ->> 'expense_id' = split_part(g.source_id, ':', 3);

-- The corrections list on the Tally integration page also says whether a correction was for a deleted or an edited expense.
CREATE OR REPLACE FUNCTION public.pwt_list_deletions_v1(p_organization_id uuid, p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
    SELECT id, transaction_number, voucher_number, voucher_date, amount, employee_ledger, status, action, attempts, error,
           detected_via, reason, created_at, completed_at
      FROM public.pwt_deletion_jobs WHERE organization_id = p_organization_id
     ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 100)) x), '[]'::jsonb);
END $$;
