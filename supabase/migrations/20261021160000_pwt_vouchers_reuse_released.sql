-- Re-syncing after a failed delivery failed with: duplicate key value violates unique constraint "pwt_vouchers_pkey".
-- A failed batch marks its vouchers 'released' (the rows are kept); the next sync plans the same voucher date + number again and the plain INSERT collided.
-- Released rows are now reused. Rows that are 'planned' or 'posted' still conflict (two syncs must never claim the same voucher).
-- Only pwt_complete_prep_v1 is replaced; no table, column or data changes.

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
