-- Team leaders / executives may verify, reject, and correct when assigned as reviewer OR engineer.

CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act(
  e public.expenses,
  v_uid uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.is_active = true
      AND (
        (
          om.role = 'team_leader'
          AND (
            e.approval_tier IS NULL
            OR e.approval_tier = 'team_leader'
          )
        )
        OR (
          om.role = 'executive'
          AND (
            e.approval_tier IS NULL
            OR e.approval_tier = 'executive'
          )
        )
      )
  )
  AND (
    e.assigned_reviewer_id = v_uid
    OR e.assigned_engineer_id = v_uid
  );
$$;

CREATE OR REPLACE FUNCTION public.reviewer_can_act_on_expense(p_expense_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF public.expense_hierarchy_reviewer_can_act(e, auth.uid()) THEN
    RETURN true;
  END IF;

  IF public.expense_manager_can_review(e, auth.uid()) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.reviewer_can_act_on_expense(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reviewer_can_act_on_expense(uuid) TO authenticated;

COMMENT ON FUNCTION public.expense_hierarchy_reviewer_can_act(public.expenses, uuid) IS
  'True when TL/executive is assigned on this expense at their tier (reviewer or legacy engineer assignment).';

COMMENT ON FUNCTION public.reviewer_can_act_on_expense(uuid) IS
  'True when the signed-in user may verify, reject, or correct the expense.';

-- apply_expense_correction: use shared hierarchy helper (re-deploy full function from 20260522140000 with one line change).
CREATE OR REPLACE FUNCTION public.apply_expense_correction(
  p_expense_id uuid,
  p_updates jsonb,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_org uuid;
  v_feature boolean := false;
  v_is_admin boolean := false;
  v_is_assigned_engineer boolean := false;
  v_is_hierarchy_reviewer boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_title text;
  v_destination text;
  v_trip_start date;
  v_trip_end date;
  v_purpose text;
  v_category text;
  v_total numeric;
  v_admin_comment text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' THEN
    RAISE EXCEPTION 'Invalid updates payload';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_updates) AS k LIMIT 1) THEN
    RAISE EXCEPTION 'Updates payload is empty';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  v_org := e.organization_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Expense has no organization';
  END IF;

  IF e.user_id = v_uid THEN
    RAISE EXCEPTION 'Corrections are only for expenses submitted by another user';
  END IF;

  IF e.status IN ('draft', 'approved', 'paid') THEN
    RAISE EXCEPTION 'This expense cannot be corrected in its current status';
  END IF;

  IF e.status NOT IN ('submitted', 'verified', 'under_review', 'rejected', 'edited') THEN
    RAISE EXCEPTION 'This expense cannot be corrected in its current status';
  END IF;

  IF to_regclass('public.organization_features') IS NOT NULL THEN
    SELECT COALESCE(ofe.enabled, false)
    INTO v_feature
    FROM public.organization_features ofe
    WHERE ofe.organization_id = v_org
      AND ofe.feature_key = 'allow_manager_admin_expense_corrections'
    LIMIT 1;
  END IF;

  IF NOT COALESCE(v_feature, false) THEN
    RAISE EXCEPTION 'Manager/admin expense corrections are disabled for this organization';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_org
      AND om.role = 'admin'
      AND om.is_active = true
  ) INTO v_is_admin;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_org
      AND om.role = 'engineer'
      AND om.is_active = true
  ) AND (e.assigned_engineer_id = v_uid OR (e.approval_tier = 'engineer' AND e.assigned_reviewer_id = v_uid))
  INTO v_is_assigned_engineer;

  SELECT public.expense_hierarchy_reviewer_can_act(e, v_uid)
  INTO v_is_hierarchy_reviewer;

  IF NOT v_is_admin AND NOT v_is_assigned_engineer AND NOT v_is_hierarchy_reviewer THEN
    RAISE EXCEPTION 'Not allowed to correct this expense';
  END IF;

  v_before := jsonb_build_object(
    'title', e.title,
    'destination', e.destination,
    'trip_start', e.trip_start,
    'trip_end', e.trip_end,
    'purpose', e.purpose,
    'category', e.category,
    'total_amount', e.total_amount,
    'admin_comment', e.admin_comment
  );

  v_title := e.title;
  v_destination := e.destination;
  v_trip_start := e.trip_start;
  v_trip_end := e.trip_end;
  v_purpose := e.purpose;
  v_category := e.category;
  v_total := e.total_amount;
  v_admin_comment := e.admin_comment;

  IF p_updates ? 'title' THEN
    v_title := nullif(trim(p_updates->>'title'), '');
    IF v_title IS NULL THEN RAISE EXCEPTION 'title cannot be empty'; END IF;
  END IF;
  IF p_updates ? 'destination' THEN
    v_destination := nullif(trim(p_updates->>'destination'), '');
    IF v_destination IS NULL THEN RAISE EXCEPTION 'destination cannot be empty'; END IF;
  END IF;
  IF p_updates ? 'trip_start' THEN
    v_trip_start := (p_updates->>'trip_start')::date;
  END IF;
  IF p_updates ? 'trip_end' THEN
    v_trip_end := (p_updates->>'trip_end')::date;
  END IF;
  IF p_updates ? 'purpose' THEN
    v_purpose := nullif(p_updates->>'purpose', '');
  END IF;
  IF p_updates ? 'category' THEN
    v_category := nullif(trim(p_updates->>'category'), '');
  END IF;
  IF p_updates ? 'total_amount' THEN
    v_total := (p_updates->>'total_amount')::numeric;
    IF v_total IS NULL OR v_total <= 0 THEN
      RAISE EXCEPTION 'total_amount must be a positive number';
    END IF;
  END IF;
  IF p_updates ? 'admin_comment' THEN
    v_admin_comment := nullif(p_updates->>'admin_comment', '');
  END IF;

  UPDATE public.expenses
  SET
    title = v_title,
    destination = v_destination,
    trip_start = v_trip_start,
    trip_end = v_trip_end,
    purpose = v_purpose,
    category = v_category,
    total_amount = v_total,
    admin_comment = v_admin_comment,
    status = 'edited'::public.expense_status,
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT jsonb_build_object(
    'title', title,
    'destination', destination,
    'trip_start', trip_start,
    'trip_end', trip_end,
    'purpose', purpose,
    'category', category,
    'total_amount', total_amount,
    'admin_comment', admin_comment,
    'status', status
  )
  INTO v_after
  FROM public.expenses
  WHERE id = p_expense_id;

  INSERT INTO public.expense_correction_logs (
    expense_id, organization_id, edited_by, reason, before_json, after_json
  ) VALUES (
    p_expense_id, v_org, v_uid, nullif(trim(p_reason), ''), v_before, v_after
  );

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_expense_correction(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_expense_correction(uuid, jsonb, text) TO authenticated;
