-- PesoWise -> TallyPrime: organisation setting "postingDatePolicy" (month_end = default, month_start).
-- Some TallyPrime editions (Educational mode) accept only certain voucher dates; the first day of the month is accepted by all of them.
-- Only pwt_save_config_v1 is replaced (one more allowed key); no table or data changes.

CREATE OR REPLACE FUNCTION public.pwt_save_config_v1(p_organization_id uuid, p_config jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cats jsonb;
  v_clean jsonb := '{}'::jsonb;
  c jsonb;
  v_serials int[] := '{}';
  v_types text[] := '{}';
  v_serial int;
  v_type text;
BEGIN
  PERFORM public.pwt_assert_admin_v1(p_organization_id);
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'config must be an object' USING ERRCODE = '22023';
  END IF;

  v_cats := p_config -> 'categories';
  IF v_cats IS NULL OR jsonb_typeof(v_cats) <> 'array' OR jsonb_array_length(v_cats) = 0 THEN
    RAISE EXCEPTION 'categories must be a non-empty list' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(v_cats) > 200 THEN
    RAISE EXCEPTION 'too many categories' USING ERRCODE = '22023';
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(v_cats) LOOP
    IF jsonb_typeof(c) <> 'object'
       OR length(btrim(COALESCE(c ->> 'expenseType', ''))) = 0
       OR length(btrim(COALESCE(c ->> 'expenseLedger', ''))) = 0
       OR (c ->> 'serial') IS NULL OR (c ->> 'serial') !~ '^[0-9]{1,2}$' THEN
      RAISE EXCEPTION 'each category needs expenseType, expenseLedger and a serial between 1 and 99' USING ERRCODE = '22023';
    END IF;
    v_serial := (c ->> 'serial')::int;
    v_type := lower(btrim(c ->> 'expenseType'));
    IF v_serial < 1 THEN RAISE EXCEPTION 'serial must be 1-99' USING ERRCODE = '22023'; END IF;
    IF v_serial = ANY (v_serials) THEN RAISE EXCEPTION 'duplicate serial %', v_serial USING ERRCODE = '22023'; END IF;
    IF v_type = ANY (v_types) THEN RAISE EXCEPTION 'duplicate expense type %', c ->> 'expenseType' USING ERRCODE = '22023'; END IF;
    v_serials := v_serials || v_serial;
    v_types := v_types || v_type;
  END LOOP;

  -- whitelist: only known keys are stored
  v_clean := jsonb_build_object('categories', (
    SELECT jsonb_agg(jsonb_build_object(
      'expenseType', btrim(e ->> 'expenseType'),
      'expenseLedger', btrim(e ->> 'expenseLedger'),
      'serial', (e ->> 'serial')::int,
      'aliases', COALESCE((SELECT jsonb_agg(btrim(a)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e -> 'aliases') = 'array' THEN e -> 'aliases' ELSE '[]'::jsonb END) a WHERE length(btrim(a)) > 0), '[]'::jsonb)
    ) ORDER BY (e ->> 'serial')::int) FROM jsonb_array_elements(v_cats) e));

  IF p_config ? 'voucherPrefix' THEN
    IF (p_config ->> 'voucherPrefix') !~ '^[A-Za-z0-9]{1,10}$' THEN
      RAISE EXCEPTION 'voucherPrefix must be 1-10 letters or digits' USING ERRCODE = '22023';
    END IF;
    v_clean := v_clean || jsonb_build_object('voucherPrefix', upper(p_config ->> 'voucherPrefix'));
  END IF;
  IF p_config ? 'expenseSide' THEN
    IF (p_config ->> 'expenseSide') NOT IN ('debit', 'credit') THEN
      RAISE EXCEPTION 'expenseSide must be debit or credit' USING ERRCODE = '22023';
    END IF;
    v_clean := v_clean || jsonb_build_object('expenseSide', p_config ->> 'expenseSide');
  END IF;
  IF p_config ? 'voucherType' THEN
    IF length(btrim(COALESCE(p_config ->> 'voucherType', ''))) = 0 OR length(p_config ->> 'voucherType') > 60 THEN
      RAISE EXCEPTION 'voucherType is invalid' USING ERRCODE = '22023';
    END IF;
    v_clean := v_clean || jsonb_build_object('voucherType', btrim(p_config ->> 'voucherType'));
  END IF;
  IF p_config ? 'employeeLedgerParent' AND length(btrim(COALESCE(p_config ->> 'employeeLedgerParent', ''))) > 0 THEN
    v_clean := v_clean || jsonb_build_object('employeeLedgerParent', btrim(p_config ->> 'employeeLedgerParent'));
  END IF;
  IF p_config ? 'expenseLedgerParent' AND length(btrim(COALESCE(p_config ->> 'expenseLedgerParent', ''))) > 0 THEN
    v_clean := v_clean || jsonb_build_object('expenseLedgerParent', btrim(p_config ->> 'expenseLedgerParent'));
  END IF;

  IF p_config ? 'reportRowsInTally' THEN
    IF jsonb_typeof(p_config -> 'reportRowsInTally') <> 'boolean' THEN
      RAISE EXCEPTION 'reportRowsInTally must be true or false' USING ERRCODE = '22023';
    END IF;
    v_clean := v_clean || jsonb_build_object('reportRowsInTally', (p_config ->> 'reportRowsInTally')::boolean);
  END IF;

  IF p_config ? 'postingDatePolicy' THEN
    IF (p_config ->> 'postingDatePolicy') NOT IN ('month_end', 'month_start') THEN
      RAISE EXCEPTION 'postingDatePolicy must be month_end or month_start' USING ERRCODE = '22023';
    END IF;
    v_clean := v_clean || jsonb_build_object('postingDatePolicy', p_config ->> 'postingDatePolicy');
  END IF;

  INSERT INTO public.pwt_mapping_config (organization_id, config, updated_by, updated_at)
  VALUES (p_organization_id, v_clean, auth.uid(), now())
  ON CONFLICT (organization_id) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;

REVOKE ALL ON FUNCTION public.pwt_save_config_v1(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pwt_save_config_v1(uuid, jsonb) TO authenticated;
