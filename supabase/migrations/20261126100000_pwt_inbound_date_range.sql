-- Sync from Tally: choose the dates to read.
--   * date_from / date_to are optional VOUCHER dates (the date written on the voucher in Tally, not the day it was typed). Both empty = all dates.
--   * The connector asks Tally for only that period, and the server enforces it again: a voucher outside the dates is never imported,
--     never flagged, and only counted (out_of_range_count).
--   * "Deleted in Tally" detection looks only at payments inside the selected dates, so narrowing the dates cannot make older payments look deleted.
ALTER TABLE public.pwt_inbound_jobs
  ADD COLUMN IF NOT EXISTS date_from date,
  ADD COLUMN IF NOT EXISTS date_to date,
  ADD COLUMN IF NOT EXISTS out_of_range_count integer NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public.pwt_inbound_create_job_v1(uuid);
CREATE OR REPLACE FUNCTION public.pwt_inbound_create_job_v1(p_organization_id uuid, p_date_from date DEFAULT NULL, p_date_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company text; v_existing uuid; v_id uuid;
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL AND p_date_from > p_date_to THEN
    RAISE EXCEPTION 'the start date is after the end date' USING ERRCODE = '22023';
  END IF;
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
  INSERT INTO public.pwt_inbound_jobs (organization_id, tally_company, created_by, voucher_type, date_from, date_to)
  VALUES (p_organization_id, v_company, auth.uid(),
          COALESCE((SELECT voucher_type FROM public.pwt_inbound_settings WHERE organization_id = p_organization_id), 'PesoWise Payment'),
          p_date_from, p_date_to)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('job_id', v_id, 'deduplicated', false, 'tally_company', v_company, 'date_from', p_date_from, 'date_to', p_date_to);
END $$;
REVOKE ALL ON FUNCTION public.pwt_inbound_create_job_v1(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_inbound_create_job_v1(uuid, date, date) TO authenticated;

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
  RETURN jsonb_build_object('job_id', j.id, 'tally_company', j.tally_company, 'voucher_type', j.voucher_type,
                            'date_from', j.date_from, 'date_to', j.date_to);
END $$;

CREATE OR REPLACE FUNCTION public.pwt_inbound_list_jobs_v1(p_organization_id uuid, p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.created_at DESC) FROM (
    SELECT pj.id, pj.status, pj.tally_company, pj.created_at, pj.completed_at, pj.vouchers_fetched, pj.imported_count, pj.already_imported_count,
           pj.skipped_count, pj.unmatched_count, pj.failed_count, pj.flagged_count, pj.imported_amount, pj.progress_current, pj.progress_total, pj.error,
           pj.batch_id, b.status AS batch_status, pj.date_from, pj.date_to, pj.out_of_range_count, pj.voucher_type
      FROM public.pwt_inbound_jobs pj
      LEFT JOIN public.balance_import_batches b ON b.id = pj.batch_id
     WHERE pj.organization_id = p_organization_id
     ORDER BY pj.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 50)) j), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public._pwt_inbound_process_v1(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j public.pwt_inbound_jobs%ROWTYPE;
  v record; e record; r record;
  v_imported int := 0; v_already int := 0; v_skipped int := 0; v_unmatched int := 0; v_failed int := 0; v_flagged int := 0;
  v_amount numeric(14, 2) := 0;
  v_batch uuid; v_rowno int := 0;
  v_guids text[] := '{}';
  v_out int := 0;   -- vouchers outside the selected dates (ignored)
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
      v_date := NULL;
      BEGIN v_date := (v.d ->> 'date')::date; EXCEPTION WHEN others THEN v_date := NULL; END;
      -- the selected dates are enforced HERE too, whatever the connector sent: a voucher outside them is never looked at, imported or flagged
      IF v_date IS NOT NULL AND ((j.date_from IS NOT NULL AND v_date < j.date_from) OR (j.date_to IS NOT NULL AND v_date > j.date_to)) THEN
        v_out := v_out + 1;
        CONTINUE;
      END IF;
      v_guids := v_guids || g;

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
             COALESCE(bool_and(COALESCE(lower(btrim(x ->> 'parent')) = ANY (SELECT lower(p) FROM unnest(v_bank_parents) p), false)) FILTER (WHERE (x ->> 'amount')::numeric > 0), false)
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
         AND (j.date_from IS NULL OR voucher_date >= j.date_from)
         AND (j.date_to IS NULL OR voucher_date <= j.date_to)
         AND EXISTS (SELECT 1 FROM public.pwt_inbound_jobs pj WHERE pj.id = public.pwt_inbound_payments.job_id AND pj.voucher_type = j.voucher_type)
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
         unmatched_count = v_unmatched, failed_count = v_failed, flagged_count = v_flagged, imported_amount = v_amount, batch_id = v_batch,
         out_of_range_count = v_out
   WHERE id = p_job_id;
  RETURN jsonb_build_object('imported', v_imported, 'already_imported', v_already, 'skipped', v_skipped, 'unmatched', v_unmatched,
                            'failed', v_failed, 'flagged', v_flagged, 'imported_amount', v_amount, 'out_of_range', v_out);
END $$;

-- Lets the website refuse to start a sync with selected dates against a server that would ignore them (which would read ALL dates).
CREATE OR REPLACE FUNCTION public.pwt_inbound_capabilities_v1() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT jsonb_build_object('date_range', true) $$;
REVOKE ALL ON FUNCTION public.pwt_inbound_capabilities_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_inbound_capabilities_v1() TO authenticated;
