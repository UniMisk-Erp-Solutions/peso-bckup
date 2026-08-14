-- Manager/admin corrections: audit table, RPC, RLS (uses status `edited`).
-- Requires 20260513139900_expense_status_add_edited_enum.sql applied first (separate transaction).
-- Feature flag: organization_features.feature_key = 'allow_manager_admin_expense_corrections'

CREATE TABLE IF NOT EXISTS public.expense_correction_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.expenses (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  edited_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  reason text,
  before_json jsonb NOT NULL,
  after_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_correction_logs_expense
  ON public.expense_correction_logs (expense_id, created_at DESC);

COMMENT ON TABLE public.expense_correction_logs IS
  'Before/after snapshots when a manager or admin corrects an employee expense (feature allow_manager_admin_expense_corrections).';

ALTER TABLE public.expense_correction_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "View correction logs for viewable expenses" ON public.expense_correction_logs;
CREATE POLICY "View correction logs for viewable expenses"
  ON public.expense_correction_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.id = expense_correction_logs.expense_id
        AND (
          ex.user_id = auth.uid()
          OR ex.assigned_engineer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.organization_memberships om
            WHERE om.user_id = auth.uid()
              AND om.organization_id = ex.organization_id
              AND om.role = 'admin'
              AND om.is_active = true
          )
        )
    )
  );

-- No INSERT/UPDATE/DELETE for authenticated; writes go through apply_expense_correction (SECURITY DEFINER).

-- Engineers assigned to an expense: verify/reject/approve transitions (include `edited` -> verified).
DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_engineer_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND status IN ('submitted', 'edited', 'verified')
  )
  WITH CHECK (
    auth.uid() = assigned_engineer_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND status IN ('verified', 'rejected', 'approved')
  );

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
  ) AND (e.assigned_engineer_id = v_uid)
  INTO v_is_assigned_engineer;

  IF NOT v_is_admin AND NOT v_is_assigned_engineer THEN
    RAISE EXCEPTION 'Not allowed to correct this expense';
  END IF;

  -- Snapshot before (correctable header fields only)
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
    v_admin_comment := p_updates->>'admin_comment';
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

COMMENT ON FUNCTION public.apply_expense_correction(uuid, jsonb, text) IS
  'Admin or assigned engineer corrects another user''s expense; requires org feature allow_manager_admin_expense_corrections. Sets status to edited.';

-- Prevent employees from self-assigning terminal-looking statuses via loose WITH CHECK.
DROP POLICY IF EXISTS "Users can update their submitted or rejected expenses" ON public.expenses;
CREATE POLICY "Users can update their submitted or rejected expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id AND
    status IN ('submitted', 'rejected')
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  )
  WITH CHECK (
    auth.uid() = user_id AND
    organization_id IS NOT NULL
    AND status IN ('submitted', 'rejected')
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

COMMENT ON POLICY "Users can update their submitted or rejected expenses" ON public.expenses IS
  'Owner may edit submitted or rejected expenses; status must remain submitted or rejected (blocks self-setting edited/approved).';
