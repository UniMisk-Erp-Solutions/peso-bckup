-- =============================================================================
-- PesoWise MASTER post-backup SQL (run once in Supabase SQL Editor)
-- =============================================================================
-- After backup reload from 2026-05-27 ~05:30 AM. All 20 migrations + URL fix.
--
-- RUN: SQL Editor -> paste entire file -> Run
-- THEN: npm run post-restore:storage (receipt files on your PC)
--
-- OLD project ref in backup URLs: briypgrgqagbexudarba
-- NEW project ref (live):         kqlqirdneocivumdjtvx
-- =============================================================================


-- -----------------------------------------------------------------------------
-- SECTION 1 / 20: 20260524180000_expense_hierarchy_review_select_expand.sql
-- -----------------------------------------------------------------------------

-- Team leaders may be assigned via assigned_reviewer_id or assigned_engineer_id at their tier.

DROP POLICY IF EXISTS "Hierarchy reviewers can view assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    expenses.approval_tier IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (
            om.role = 'team_leader'
            AND expenses.approval_tier = 'team_leader'
            AND (
              expenses.assigned_reviewer_id = auth.uid()
              OR expenses.assigned_engineer_id = auth.uid()
            )
          )
          OR (
            om.role = 'executive'
            AND expenses.approval_tier = 'executive'
            AND (
              expenses.assigned_reviewer_id = auth.uid()
              OR expenses.assigned_engineer_id = auth.uid()
            )
          )
        )
    )
  );

COMMENT ON POLICY "Hierarchy reviewers can view assigned expenses" ON public.expenses IS
  'TL/executive can read expenses at their tier when assigned as reviewer or managing engineer.';

-- -----------------------------------------------------------------------------
-- SECTION 2 / 20: 20260524190000_list_organizations_for_dev_login.sql
-- -----------------------------------------------------------------------------

-- Minimal org list for localhost dev tenant picker on the login page (subdomain labels only).

CREATE OR REPLACE FUNCTION public.list_organizations_for_dev_login()
RETURNS TABLE (id uuid, name text, slug text, subdomain text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.slug, o.subdomain
  FROM public.organizations o
  WHERE o.subdomain IS NOT NULL
    AND length(trim(o.subdomain)) > 0
  ORDER BY o.name;
$$;

GRANT EXECUTE ON FUNCTION public.list_organizations_for_dev_login() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_organizations_for_dev_login() IS
  'Lists tenant hosts (subdomain) for localhost dev login picker; UI is localhost-only.';

-- -----------------------------------------------------------------------------
-- SECTION 3 / 20: 20260524190100_fix_dev_tenant_list_use_slug.sql
-- -----------------------------------------------------------------------------

-- Dev tenant picker + lookup: use slug when subdomain column is empty (common before Master Admin sets subdomain).

CREATE OR REPLACE FUNCTION public.list_organizations_for_dev_login()
RETURNS TABLE (id uuid, name text, slug text, subdomain text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.name,
    o.slug,
    lower(trim(COALESCE(NULLIF(trim(o.subdomain), ''), NULLIF(trim(o.slug), '')))) AS subdomain
  FROM public.organizations o
  WHERE COALESCE(NULLIF(trim(o.subdomain), ''), NULLIF(trim(o.slug), '')) IS NOT NULL
  ORDER BY o.name;
$$;

DROP FUNCTION IF EXISTS public.get_organization_by_subdomain(text);

CREATE FUNCTION public.get_organization_by_subdomain(p_subdomain text)
RETURNS TABLE (id uuid, name text, slug text, logo_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.slug, o.logo_url
  FROM public.organizations o
  WHERE lower(trim(COALESCE(NULLIF(trim(o.subdomain), ''), NULLIF(trim(o.slug), ''))))
    = lower(trim(p_subdomain))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_by_subdomain(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_organizations_for_dev_login() IS
  'Lists orgs for localhost dev login picker; tenant label is subdomain or slug.';

COMMENT ON FUNCTION public.get_organization_by_subdomain(text) IS
  'Resolves tenant host label against organizations.subdomain or slug fallback.';

-- -----------------------------------------------------------------------------
-- SECTION 4 / 20: 20260524200000_tl_executive_expense_submit_and_select.sql
-- -----------------------------------------------------------------------------

-- Allow team leaders and executives to create expenses; broaden hierarchy reviewer SELECT.

DROP POLICY IF EXISTS "Employees, engineers, admins, or cashiers when allowed can create expenses"
  ON public.expenses;

CREATE POLICY "Employees, engineers, admins, or cashiers when allowed can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_id
        AND om.is_active = true
        AND (
          om.role IN ('employee', 'engineer', 'admin', 'team_leader', 'executive')
          OR (
            om.role = 'cashier'
            AND EXISTS (
              SELECT 1 FROM public.organization_settings os
              WHERE os.organization_id = organization_id
                AND os.allow_cashier_expense_submission = true
            )
          )
        )
    )
  );

-- Reviewers may read any expense currently assigned to them (tier may change after verify).
DROP POLICY IF EXISTS "Hierarchy reviewers can view assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (
            om.role = 'team_leader'
            AND (
              (
                expenses.approval_tier = 'team_leader'
                AND (
                  expenses.assigned_reviewer_id = auth.uid()
                  OR expenses.assigned_engineer_id = auth.uid()
                )
              )
              OR expenses.assigned_reviewer_id = auth.uid()
            )
          )
          OR (
            om.role = 'executive'
            AND (
              (
                expenses.approval_tier = 'executive'
                AND (
                  expenses.assigned_reviewer_id = auth.uid()
                  OR expenses.assigned_engineer_id = auth.uid()
                )
              )
              OR expenses.assigned_reviewer_id = auth.uid()
            )
          )
        )
    )
  );

COMMENT ON POLICY "Hierarchy reviewers can view assigned expenses" ON public.expenses IS
  'TL/executive can read expenses at their tier or any expense still assigned to them as reviewer.';

-- -----------------------------------------------------------------------------
-- SECTION 5 / 20: 20260524210000_list_hierarchy_reviewer_expenses_rpc.sql
-- -----------------------------------------------------------------------------

-- List expenses assigned to the current team leader / executive (bypasses SELECT RLS gaps).

CREATE OR REPLACE FUNCTION public.list_hierarchy_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review'
    )
    AND (
      e.assigned_reviewer_id = auth.uid()
      OR e.assigned_engineer_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    );
$$;

REVOKE ALL ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_hierarchy_reviewer_expenses(uuid) IS
  'Returns expenses awaiting action by the signed-in team leader or executive (matches notification routing).';

-- Backfill rows that notified via assigned_engineer_id only (legacy submit path).
UPDATE public.expenses e
SET
  approval_tier = 'team_leader',
  assigned_reviewer_id = e.assigned_engineer_id
WHERE e.approval_tier IS NULL
  AND e.assigned_reviewer_id IS NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND e.assigned_engineer_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  );

UPDATE public.expenses e
SET
  approval_tier = 'executive',
  assigned_reviewer_id = e.assigned_engineer_id
WHERE e.approval_tier IS NULL
  AND e.assigned_reviewer_id IS NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND e.assigned_engineer_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  );

-- -----------------------------------------------------------------------------
-- SECTION 6 / 20: 20260524220000_fix_hierarchy_reviewer_act_permissions.sql
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- SECTION 7 / 20: 20260524230000_fix_hierarchy_verify_advance.sql
-- -----------------------------------------------------------------------------

-- Fix TL verify: allow advance when approval_tier is NULL (legacy assignment) and expose review head for routing.

CREATE OR REPLACE FUNCTION public.get_expense_review_head(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT (
    public.reviewer_can_act_on_expense(p_expense_id)
    OR e.user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  ) THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', e.id,
    'organization_id', e.organization_id,
    'status', e.status,
    'approval_tier', e.approval_tier,
    'assigned_reviewer_id', e.assigned_reviewer_id,
    'assigned_engineer_id', e.assigned_engineer_id,
    'user_id', e.user_id,
    'title', e.title,
    'total_amount', e.total_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_expense_review_head(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_review_head(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at this tier';
  END IF;

  IF e.approval_tier IS NOT NULL AND e.approval_tier NOT IN ('team_leader', 'executive') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  UPDATE public.expenses
  SET
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(p_next_assigned_engineer_id, p_next_assigned_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_engineer_id
    END,
    status = 'submitted',
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.review_verify_expense(
  p_expense_id uuid,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved and cannot be updated';
  END IF;

  IF e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive')
    OR (
      e.approval_tier IS NULL
      AND public.expense_hierarchy_reviewer_can_act(e, v_uid)
    ) THEN
    RAISE EXCEPTION 'Use Verify on this screen to complete the team leader or executive step first (not manager verify)';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 8 / 20: 20260524240000_hierarchy_tl_verify_fix.sql
-- -----------------------------------------------------------------------------

-- Team leader verify: allow mis-tiered rows (approval_tier=engineer but TL is assignee) and backfill.

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
            OR e.approval_tier IN ('team_leader', 'engineer')
          )
        )
        OR (
          om.role = 'executive'
          AND (
            e.approval_tier IS NULL
            OR e.approval_tier IN ('executive', 'engineer')
          )
        )
      )
  )
  AND (
    e.assigned_reviewer_id = v_uid
    OR e.assigned_engineer_id = v_uid
  );
$$;

-- Mis-routed: engineer tier but assignee is actually a team leader / executive.
UPDATE public.expenses e
SET
  approval_tier = 'team_leader',
  assigned_reviewer_id = COALESCE(e.assigned_reviewer_id, e.assigned_engineer_id)
WHERE e.approval_tier = 'engineer'
  AND e.assigned_engineer_id IS NOT NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  );

UPDATE public.expenses e
SET
  approval_tier = 'executive',
  assigned_reviewer_id = COALESCE(e.assigned_reviewer_id, e.assigned_engineer_id)
WHERE e.approval_tier = 'engineer'
  AND e.assigned_engineer_id IS NOT NULL
  AND e.status IN ('submitted', 'edited', 'under_review')
  AND EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = e.assigned_engineer_id
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  );

CREATE OR REPLACE FUNCTION public.get_expense_review_head(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT (
    public.reviewer_can_act_on_expense(p_expense_id)
    OR e.user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    OR (
      (e.assigned_reviewer_id = auth.uid() OR e.assigned_engineer_id = auth.uid())
      AND EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = auth.uid()
          AND om.organization_id = e.organization_id
          AND om.role IN ('team_leader', 'executive')
          AND om.is_active = true
      )
    )
  ) THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', e.id,
    'organization_id', e.organization_id,
    'status', e.status,
    'approval_tier', e.approval_tier,
    'assigned_reviewer_id', e.assigned_reviewer_id,
    'assigned_engineer_id', e.assigned_engineer_id,
    'user_id', e.user_id,
    'title', e.title,
    'total_amount', e.total_amount
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at this tier';
  END IF;

  IF e.approval_tier IS NOT NULL
    AND e.approval_tier NOT IN ('team_leader', 'executive', 'engineer') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  UPDATE public.expenses
  SET
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(p_next_assigned_engineer_id, p_next_assigned_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_engineer_id
    END,
    status = 'submitted',
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 9 / 20: 20260524250000_hierarchy_verification_statuses.sql
-- -----------------------------------------------------------------------------

-- Part 1/2: Add enum values only. Must run in its own migration (committed) before part 2.
-- PostgreSQL error 55P04 if new enum values are used in the same transaction.

ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'level_1_verified';
ALTER TYPE public.expense_status ADD VALUE IF NOT EXISTS 'level_2_verified';

-- -----------------------------------------------------------------------------
-- SECTION 10 / 20: 20260524250100_hierarchy_verification_statuses_apply.sql
-- -----------------------------------------------------------------------------

-- Part 2/2: Functions and RLS using level_1_verified / level_2_verified (run after 20260524250000).

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
  v_new_status public.expense_status;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.approval_tier = 'team_leader' AND e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at team leader tier';
  END IF;

  IF e.approval_tier = 'executive' AND e.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
    RAISE EXCEPTION 'Only expenses awaiting executive review can be verified at this tier';
  END IF;

  IF e.approval_tier IS NULL AND e.status NOT IN ('submitted', 'edited') THEN
    RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at this tier';
  END IF;

  IF e.approval_tier IS NOT NULL
    AND e.approval_tier NOT IN ('team_leader', 'executive', 'engineer') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  v_new_status := CASE
    WHEN e.approval_tier = 'team_leader' THEN 'level_1_verified'::public.expense_status
    WHEN e.approval_tier = 'executive' THEN 'level_2_verified'::public.expense_status
    WHEN e.approval_tier IS NULL AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = v_uid AND om.organization_id = e.organization_id
        AND om.role = 'team_leader' AND om.is_active = true
    ) THEN 'level_1_verified'::public.expense_status
    WHEN e.approval_tier IS NULL AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = v_uid AND om.organization_id = e.organization_id
        AND om.role = 'executive' AND om.is_active = true
    ) THEN 'level_2_verified'::public.expense_status
    ELSE e.status
  END;

  UPDATE public.expenses
  SET
    status = v_new_status,
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(p_next_assigned_engineer_id, p_next_assigned_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_engineer_id
    END,
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_hierarchy_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND (
      e.assigned_reviewer_id = auth.uid()
      OR e.assigned_engineer_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    );
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_verify_expense(
  p_expense_id uuid,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved and cannot be updated';
  END IF;

  IF e.status NOT IN ('submitted', 'edited', 'level_2_verified') THEN
    RAISE EXCEPTION 'Only submitted, adjusted, or level 2 verified expenses can be verified by a manager';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive')
    OR (
      e.approval_tier IS NULL
      AND public.expense_hierarchy_reviewer_can_act(e, v_uid)
    ) THEN
    RAISE EXCEPTION 'This expense must be verified by the team leader or executive before manager verification';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

DROP POLICY IF EXISTS "Hierarchy reviewers can update assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    (auth.uid() = assigned_reviewer_id OR auth.uid() = assigned_engineer_id)
    AND (
      (
        approval_tier = 'team_leader'
        AND status IN ('submitted', 'edited')
      )
      OR (
        approval_tier = 'executive'
        AND status IN ('submitted', 'edited', 'level_1_verified')
      )
      OR (
        approval_tier IS NULL
        AND status IN ('submitted', 'edited', 'level_1_verified')
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (om.role = 'team_leader' AND (expenses.approval_tier IS NULL OR expenses.approval_tier = 'team_leader'))
          OR (om.role = 'executive' AND (expenses.approval_tier IS NULL OR expenses.approval_tier = 'executive'))
        )
    )
  )
  WITH CHECK (
    status IN ('submitted', 'edited', 'rejected', 'level_1_verified', 'level_2_verified')
    AND status <> 'approved'
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND om.role IN ('team_leader', 'executive')
    )
  );

-- -----------------------------------------------------------------------------
-- SECTION 11 / 20: 20260524260000_fix_hierarchy_verify_status_by_role.sql
-- -----------------------------------------------------------------------------

-- TL verify was leaving status as "submitted" when approval_tier was "engineer" (legacy rows)
-- or when an older review_advance_expense_hierarchy_tier still forced status = 'submitted'.
-- Set status from the verifying user's role (team_leader â†’ level_1_verified, executive â†’ level_2_verified).

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
  v_new_status public.expense_status;
  v_is_tl boolean;
  v_is_exec boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.approval_tier IS NOT NULL
    AND e.approval_tier NOT IN ('team_leader', 'executive', 'engineer') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  ) INTO v_is_tl;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  ) INTO v_is_exec;

  IF v_is_tl THEN
    IF e.status NOT IN ('submitted', 'edited') THEN
      RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at team leader tier';
    END IF;
    v_new_status := 'level_1_verified'::public.expense_status;
  ELSIF v_is_exec THEN
    IF e.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
      RAISE EXCEPTION 'Only expenses awaiting executive review can be verified at this tier';
    END IF;
    v_new_status := 'level_2_verified'::public.expense_status;
  ELSE
    RAISE EXCEPTION 'Only team leaders and executives can verify at hierarchy tiers';
  END IF;

  UPDATE public.expenses
  SET
    status = v_new_status,
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(p_next_assigned_engineer_id, p_next_assigned_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_engineer_id
    END,
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 12 / 20: 20260524270000_backfill_level2_queue_after_tl_verify.sql
-- -----------------------------------------------------------------------------

-- Re-route expenses already Level-1 verified (or stuck submitted after TL verify) to the
-- executive / Level-2 queue WITHOUT resubmitting. Safe to run multiple times.

WITH candidates AS (
  SELECT
    e.id,
    e.organization_id,
    e.user_id,
    e.assigned_reviewer_id,
    e.assigned_engineer_id,
    e.status
  FROM public.expenses e
  WHERE (
      e.status = 'level_1_verified'::public.expense_status
      AND COALESCE(e.approval_tier, '') <> 'executive'
    )
    OR (
      e.status IN ('submitted'::public.expense_status, 'edited'::public.expense_status)
      AND EXISTS (
        SELECT 1
        FROM public.audit_logs al
        WHERE al.expense_id = e.id
          AND al.action = 'tier_advanced'
          AND al.comment ILIKE '%team_leader%'
      )
    )
),
submitter_team AS (
  SELECT
    c.id AS expense_id,
    t.executive_user_id
  FROM candidates c
  JOIN public.team_members tm
    ON tm.user_id = c.user_id
    AND tm.organization_id = c.organization_id
  JOIN public.teams t ON t.id = tm.team_id
),
tl_supervisor AS (
  SELECT
    c.id AS expense_id,
    p_boss.user_id AS exec_id
  FROM candidates c
  JOIN public.profiles p_tl
    ON p_tl.user_id = COALESCE(c.assigned_reviewer_id, c.assigned_engineer_id)
  JOIN public.profiles p_boss
    ON p_boss.user_id = p_tl.reporting_engineer_id
  JOIN public.organization_memberships om
    ON om.user_id = p_boss.user_id
    AND om.organization_id = c.organization_id
    AND om.role = 'executive'
    AND om.is_active = true
),
resolved AS (
  SELECT
    c.id AS expense_id,
    COALESCE(st.executive_user_id, ts.exec_id) AS executive_user_id
  FROM candidates c
  LEFT JOIN submitter_team st ON st.expense_id = c.id
  LEFT JOIN tl_supervisor ts ON ts.expense_id = c.id
  WHERE COALESCE(st.executive_user_id, ts.exec_id) IS NOT NULL
)
UPDATE public.expenses e
SET
  status = 'level_1_verified'::public.expense_status,
  approval_tier = 'executive',
  assigned_reviewer_id = r.executive_user_id,
  assigned_engineer_id = r.executive_user_id,
  updated_at = now()
FROM resolved r
WHERE e.id = r.expense_id;

-- -----------------------------------------------------------------------------
-- SECTION 13 / 20: 20260524280000_manager_review_queue_and_managing_engineer.sql
-- -----------------------------------------------------------------------------

-- Managers (engineers) keep visibility while expenses move through TL/executive tiers.
-- list_manager_reviewer_expenses mirrors hierarchy RPC for reliable review queues.

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
  v_new_status public.expense_status;
  v_is_tl boolean;
  v_is_exec boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.approval_tier IS NOT NULL
    AND e.approval_tier NOT IN ('team_leader', 'executive', 'engineer') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  ) INTO v_is_tl;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  ) INTO v_is_exec;

  IF v_is_tl THEN
    IF e.status NOT IN ('submitted', 'edited') THEN
      RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at team leader tier';
    END IF;
    v_new_status := 'level_1_verified'::public.expense_status;
  ELSIF v_is_exec THEN
    IF e.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
      RAISE EXCEPTION 'Only expenses awaiting executive review can be verified at this tier';
    END IF;
    v_new_status := 'level_2_verified'::public.expense_status;
  ELSE
    RAISE EXCEPTION 'Only team leaders and executives can verify at hierarchy tiers';
  END IF;

  UPDATE public.expenses
  SET
    status = v_new_status,
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE p_next_assigned_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(p_next_assigned_engineer_id, p_next_assigned_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE COALESCE(p_next_assigned_engineer_id, e.assigned_engineer_id)
    END,
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR (
        e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
    );
$$;

REVOKE ALL ON FUNCTION public.list_manager_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_reviewer_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_manager_reviewer_expenses(uuid) IS
  'Returns expenses visible to the signed-in manager (engineer) for review, including hierarchy pipeline rows.';

-- Backfill: restore managing engineer on in-flight hierarchy expenses.
UPDATE public.expenses e
SET assigned_engineer_id = t.manager_user_id
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status IN (
    'submitted',
    'edited',
    'level_1_verified',
    'level_2_verified',
    'under_review'
  )
  AND (
    e.approval_tier IN ('team_leader', 'executive')
    OR (e.status = 'level_2_verified' AND COALESCE(e.approval_tier, '') <> 'engineer')
    OR (e.status = 'level_1_verified' AND e.approval_tier = 'engineer')
  )
  AND (e.assigned_engineer_id IS DISTINCT FROM t.manager_user_id);

-- Route level_2_verified rows to manager when executive step is done.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_2_verified'::public.expense_status
  AND COALESCE(e.approval_tier, '') <> 'engineer';

-- -----------------------------------------------------------------------------
-- SECTION 14 / 20: 20260524290000_expand_manager_team_visibility.sql
-- -----------------------------------------------------------------------------

-- Managers who are team.manager_user_id must see all team members' in-review expenses,
-- not only profiles.reporting_engineer_id direct reports.

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR (
        e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = auth.uid()
      )
    );
$$;

DROP POLICY IF EXISTS "Engineers can view team reporting expenses" ON public.expenses;
CREATE POLICY "Engineers can view team reporting expenses"
  ON public.expenses FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
    AND (
      expenses.assigned_engineer_id = auth.uid()
      OR expenses.assigned_reviewer_id = auth.uid()
      OR (
        expenses.approval_tier = 'engineer'
        AND expenses.assigned_reviewer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = expenses.user_id
          AND p.organization_id = expenses.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = expenses.user_id
          AND tm.organization_id = expenses.organization_id
          AND t.manager_user_id = auth.uid()
      )
    )
  );

COMMENT ON POLICY "Engineers can view team reporting expenses" ON public.expenses IS
  'Managers see assigned expenses, engineer-tier queue, direct reports, and any team they manage.';

-- -----------------------------------------------------------------------------
-- SECTION 15 / 20: 20260524300000_fix_level2_verified_manager_queue.sql
-- -----------------------------------------------------------------------------

-- Fix Level 2 Verified visibility for managers and backfill stuck pipeline rows.

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR (
        e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = auth.uid()
      )
      OR (
        e.status = 'level_2_verified'
        AND EXISTS (
          SELECT 1
          FROM public.team_members tm
          JOIN public.teams t
            ON t.id = tm.team_id
            AND t.organization_id = tm.organization_id
          WHERE tm.user_id = e.user_id
            AND tm.organization_id = e.organization_id
            AND t.manager_user_id = auth.uid()
        )
      )
    );
$$;

-- Executive verified (or advanced to manager) but status never became level_2_verified.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
WHERE e.status = 'level_1_verified'::public.expense_status
  AND e.approval_tier = 'engineer';

UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
WHERE e.status = 'level_1_verified'::public.expense_status
  AND EXISTS (
    SELECT 1
    FROM public.audit_logs al
    WHERE al.expense_id = e.id
      AND al.action = 'tier_advanced'
      AND al.comment ILIKE '%executive%'
  );

-- Assign manager on level_2 rows for team members.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id,
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_2_verified'::public.expense_status
  AND (
    e.assigned_reviewer_id IS DISTINCT FROM t.manager_user_id
    OR e.assigned_engineer_id IS DISTINCT FROM t.manager_user_id
    OR COALESCE(e.approval_tier, '') <> 'engineer'
  );

-- -----------------------------------------------------------------------------
-- SECTION 16 / 20: 20260524310000_executive_handoff_to_manager_level2.sql
-- -----------------------------------------------------------------------------

-- Executive verify MUST assign level_2_verified expenses to the team manager in the database.
-- Dedicated list_manager_level2_expenses RPC so managers always see the Level 2 queue.

CREATE OR REPLACE FUNCTION public.review_advance_expense_hierarchy_tier(
  p_expense_id uuid,
  p_next_approval_tier text,
  p_next_assigned_reviewer_id uuid DEFAULT NULL,
  p_next_assigned_engineer_id uuid DEFAULT NULL,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
  v_new_status public.expense_status;
  v_is_tl boolean;
  v_is_exec boolean;
  v_team_manager_id uuid;
  v_reviewer_id uuid;
  v_engineer_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.approval_tier IS NOT NULL
    AND e.approval_tier NOT IN ('team_leader', 'executive', 'engineer') THEN
    RAISE EXCEPTION 'This expense is not awaiting hierarchy tier verification';
  END IF;

  IF NOT public.expense_hierarchy_reviewer_can_act(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to verify this expense at the current tier';
  END IF;

  IF p_next_approval_tier NOT IN ('team_leader', 'executive', 'engineer', 'admin') THEN
    RAISE EXCEPTION 'Invalid next approval tier';
  END IF;

  v_reviewer_id := p_next_assigned_reviewer_id;
  v_engineer_id := p_next_assigned_engineer_id;

  SELECT t.manager_user_id
  INTO v_team_manager_id
  FROM public.team_members tm
  JOIN public.teams t
    ON t.id = tm.team_id
    AND t.organization_id = tm.organization_id
  WHERE tm.user_id = e.user_id
    AND tm.organization_id = e.organization_id
  LIMIT 1;

  IF v_team_manager_id IS NOT NULL AND p_next_approval_tier = 'engineer' THEN
    v_reviewer_id := v_team_manager_id;
    v_engineer_id := v_team_manager_id;
  ELSIF p_next_approval_tier = 'engineer' THEN
    v_reviewer_id := COALESCE(v_reviewer_id, p_next_assigned_reviewer_id);
    v_engineer_id := COALESCE(v_engineer_id, v_reviewer_id, p_next_assigned_engineer_id);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'team_leader'
      AND om.is_active = true
  ) INTO v_is_tl;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'executive'
      AND om.is_active = true
  ) INTO v_is_exec;

  IF v_is_tl THEN
    IF e.status NOT IN ('submitted', 'edited') THEN
      RAISE EXCEPTION 'Only submitted or adjusted expenses can be verified at team leader tier';
    END IF;
    v_new_status := 'level_1_verified'::public.expense_status;
  ELSIF v_is_exec THEN
    IF e.status NOT IN ('submitted', 'edited', 'level_1_verified') THEN
      RAISE EXCEPTION 'Only expenses awaiting executive review can be verified at this tier';
    END IF;
    v_new_status := 'level_2_verified'::public.expense_status;
  ELSE
    RAISE EXCEPTION 'Only team leaders and executives can verify at hierarchy tiers';
  END IF;

  UPDATE public.expenses
  SET
    status = v_new_status,
    approval_tier = p_next_approval_tier,
    assigned_reviewer_id = CASE
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE v_reviewer_id
    END,
    assigned_engineer_id = CASE
      WHEN p_next_approval_tier = 'engineer' THEN COALESCE(v_engineer_id, v_reviewer_id)
      WHEN p_next_approval_tier = 'admin' THEN NULL
      ELSE COALESCE(v_engineer_id, e.assigned_engineer_id)
    END,
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_manager_level2_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status = 'level_2_verified'::public.expense_status
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = auth.uid()
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = auth.uid()
      )
    );
$$;

REVOKE ALL ON FUNCTION public.list_manager_level2_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_level2_expenses(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_advance_expense_hierarchy_tier(uuid, text, uuid, uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.list_manager_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_reviewer_expenses(uuid) TO authenticated;

-- Repair existing level_2 rows: assign team manager and engineer tier.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id,
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_2_verified'::public.expense_status;

-- Still level_1 but executive already advanced â€” promote to level_2 for manager queue.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  assigned_reviewer_id = COALESCE(t.manager_user_id, e.assigned_reviewer_id),
  assigned_engineer_id = COALESCE(t.manager_user_id, e.assigned_engineer_id),
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_1_verified'::public.expense_status
  AND (
    e.approval_tier = 'engineer'
    OR EXISTS (
      SELECT 1
      FROM public.audit_logs al
      WHERE al.expense_id = e.id
        AND al.action = 'tier_advanced'
        AND al.comment ILIKE '%executive%'
    )
  );

-- -----------------------------------------------------------------------------
-- SECTION 17 / 20: 20260524320000_manager_sees_stuck_executive_queue.sql
-- -----------------------------------------------------------------------------

-- Managers never saw Level 2 because status stayed "submitted" after executive verify (old RPC).
-- This migration: backfill stuck rows + RPC for manager actionable queue (incl. mislabeled statuses).

DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);
DROP FUNCTION IF EXISTS public.list_manager_level2_expenses(uuid);

CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  e public.expenses,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.assigned_engineer_id = p_user_id
    OR e.assigned_reviewer_id = p_user_id
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = e.user_id
        AND p.organization_id = e.organization_id
        AND p.reporting_engineer_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.team_members tm
      JOIN public.teams t
        ON t.id = tm.team_id
        AND t.organization_id = tm.organization_id
      WHERE tm.user_id = e.user_id
        AND tm.organization_id = e.organization_id
        AND t.manager_user_id = p_user_id
    );
$$;

CREATE OR REPLACE FUNCTION public.expense_manager_can_review(
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
      AND om.role = 'engineer'
      AND om.is_active = true
  )
  AND public.manager_expense_visible_to_user(e, v_uid);
$$;

CREATE OR REPLACE FUNCTION public.expense_ready_for_manager_review(e public.expenses)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    e.status = 'level_2_verified'
    OR (
      COALESCE(e.approval_tier, '') = 'engineer'
      AND e.status IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified')
    )
    OR (
      e.status = 'level_1_verified'
      AND COALESCE(e.approval_tier, '') = 'engineer'
    );
$$;

CREATE OR REPLACE FUNCTION public.list_manager_pending_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND public.expense_ready_for_manager_review(e)
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND e.status NOT IN ('verified', 'approved', 'rejected')
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    );
$$;

CREATE OR REPLACE FUNCTION public.list_manager_level2_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND public.expense_ready_for_manager_review(e)
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    );
$$;

CREATE OR REPLACE FUNCTION public.review_verify_expense(
  p_expense_id uuid,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved and cannot be updated';
  END IF;

  IF e.status NOT IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified') THEN
    RAISE EXCEPTION 'Only submitted, adjusted, or hierarchy-verified expenses can be verified by a manager';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive') THEN
    RAISE EXCEPTION 'This expense must be verified by the team leader or executive before manager verification';
  END IF;

  IF COALESCE(e.approval_tier, '') NOT IN ('engineer', '')
    AND e.status NOT IN ('level_2_verified') THEN
    RAISE EXCEPTION 'This expense is not at the manager review step';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    approval_tier = COALESCE(e.approval_tier, 'engineer'),
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.manager_expense_visible_to_user(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manager_expense_visible_to_user(public.expenses, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.list_manager_pending_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

-- Backfill: executive already advanced (engineer tier) but status never updated.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  updated_at = now()
WHERE COALESCE(e.approval_tier, '') = 'engineer'
  AND e.status IN (
    'submitted'::public.expense_status,
    'edited'::public.expense_status,
    'level_1_verified'::public.expense_status
  );

UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
FROM public.audit_logs al
WHERE al.expense_id = e.id
  AND al.action = 'tier_advanced'
  AND al.comment ILIKE '%executive%'
  AND e.status IN (
    'submitted'::public.expense_status,
    'edited'::public.expense_status,
    'level_1_verified'::public.expense_status
  );

-- Ensure manager assignment on all level_2 / engineer-tier queue rows.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id,
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND (
    e.status = 'level_2_verified'::public.expense_status
    OR COALESCE(e.approval_tier, '') = 'engineer'
  )
  AND e.status NOT IN ('verified', 'approved', 'rejected');

-- -----------------------------------------------------------------------------
-- SECTION 18 / 20: 20260524330000_manager_verify_auto_repair.sql
-- -----------------------------------------------------------------------------

-- Auto-repair stuck expenses when manager verifies; broaden "ready for manager" detection.

DROP FUNCTION IF EXISTS public.repair_expense_for_manager_review(uuid);

CREATE OR REPLACE FUNCTION public.expense_executive_handoff_in_audit(e public.expenses)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.audit_logs al
    WHERE al.expense_id = e.id
      AND al.action = 'tier_advanced'
      AND (
        al.comment ILIKE '%advanced to engineer%'
        OR (
          al.comment ILIKE '%verified at executive%'
          AND al.comment ILIKE '%advanced to%'
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.expense_ready_for_manager_review(e public.expenses)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    e.status = 'level_2_verified'
    OR (
      COALESCE(e.approval_tier, '') = 'engineer'
      AND e.status IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified')
      AND e.status NOT IN ('verified', 'approved', 'rejected')
    )
    OR (
      e.status IN ('submitted', 'edited', 'level_1_verified')
      AND public.expense_executive_handoff_in_audit(e)
    );
$$;

CREATE OR REPLACE FUNCTION public.repair_expense_for_manager_review(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_mgr uuid;
  v_after jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to repair this expense for manager review';
  END IF;

  IF e.status IN ('verified', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'This expense is already past manager review';
  END IF;

  IF NOT (
    public.expense_ready_for_manager_review(e)
    OR public.expense_executive_handoff_in_audit(e)
  ) THEN
    RAISE EXCEPTION 'This expense is not ready for manager queue repair';
  END IF;

  SELECT t.manager_user_id
  INTO v_mgr
  FROM public.team_members tm
  JOIN public.teams t
    ON t.id = tm.team_id
    AND t.organization_id = tm.organization_id
  WHERE tm.user_id = e.user_id
    AND tm.organization_id = e.organization_id
  LIMIT 1;

  UPDATE public.expenses
  SET
    status = 'level_2_verified'::public.expense_status,
    approval_tier = 'engineer',
    assigned_reviewer_id = COALESCE(v_mgr, assigned_reviewer_id, v_uid),
    assigned_engineer_id = COALESCE(v_mgr, assigned_engineer_id, v_uid),
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object('ok', true, 'expense', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.review_verify_expense(
  p_expense_id uuid,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_after jsonb;
  v_mgr uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.status = 'approved' THEN
    RAISE EXCEPTION 'This expense is already approved and cannot be updated';
  END IF;

  IF NOT public.expense_manager_can_review(e, v_uid) THEN
    RAISE EXCEPTION 'You don''t have permission to review this expense';
  END IF;

  IF e.status NOT IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified') THEN
    RAISE EXCEPTION 'Only submitted, adjusted, or hierarchy-verified expenses can be verified by a manager';
  END IF;

  IF e.approval_tier IN ('team_leader', 'executive')
    AND NOT public.expense_executive_handoff_in_audit(e) THEN
    RAISE EXCEPTION 'This expense must be verified by the team leader or executive before manager verification';
  END IF;

  IF public.expense_ready_for_manager_review(e)
    OR public.expense_executive_handoff_in_audit(e) THEN
  SELECT t.manager_user_id
  INTO v_mgr
  FROM public.team_members tm
  JOIN public.teams t
    ON t.id = tm.team_id
    AND t.organization_id = tm.organization_id
  WHERE tm.user_id = e.user_id
    AND tm.organization_id = e.organization_id
  LIMIT 1;

    IF e.status <> 'level_2_verified'::public.expense_status
      OR COALESCE(e.approval_tier, '') <> 'engineer' THEN
      UPDATE public.expenses
      SET
        status = 'level_2_verified'::public.expense_status,
        approval_tier = 'engineer',
        assigned_reviewer_id = COALESCE(v_mgr, assigned_reviewer_id, v_uid),
        assigned_engineer_id = COALESCE(v_mgr, assigned_engineer_id, v_uid),
        updated_at = now()
      WHERE id = p_expense_id;

      SELECT * INTO e FROM public.expenses WHERE id = p_expense_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'This expense is not at the manager review step';
  END IF;

  UPDATE public.expenses
  SET
    status = 'verified',
    approval_tier = COALESCE(e.approval_tier, 'engineer'),
    updated_at = now()
  WHERE id = p_expense_id;

  SELECT to_jsonb(ex) INTO v_after
  FROM public.expenses ex
  WHERE ex.id = p_expense_id;

  RETURN jsonb_build_object(
    'ok', true,
    'expense_id', p_expense_id,
    'expense', v_after,
    'comment', nullif(trim(p_comment), '')
  );
END;
$$;

DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);

CREATE OR REPLACE FUNCTION public.list_manager_pending_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND (
      public.expense_ready_for_manager_review(e)
      OR public.expense_executive_handoff_in_audit(e)
    )
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND e.status NOT IN ('verified', 'approved', 'rejected')
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    );
$$;

REVOKE ALL ON FUNCTION public.expense_executive_handoff_in_audit(public.expenses) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_executive_handoff_in_audit(public.expenses) TO authenticated;

REVOKE ALL ON FUNCTION public.repair_expense_for_manager_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_expense_for_manager_review(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.review_verify_expense(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_verify_expense(uuid, text) TO authenticated;

-- One-time repair for orgs that already ran 24320000 without audit-based rows.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
WHERE public.expense_executive_handoff_in_audit(e)
  AND e.status IN (
    'submitted'::public.expense_status,
    'edited'::public.expense_status,
    'level_1_verified'::public.expense_status
  );

-- -----------------------------------------------------------------------------
-- SECTION 19 / 20: 20260528183500_manager_visibility_stable_rpc.sql
-- -----------------------------------------------------------------------------

-- Stable DB-first manager visibility and repair workflow.
-- Makes manager queue deterministic for hierarchy stages.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approved_by uuid;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Existing functions with same name/signature may use different parameter names
-- or return types; drop them before recreate to avoid 42P13/replace conflicts.
DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);
DROP FUNCTION IF EXISTS public.repair_expense_for_manager_review(uuid);

CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  p_expense_id uuid,
  p_manager_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_manager_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.expenses e
      WHERE e.id = p_expense_id
        AND e.status::text IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified')
        AND (
          e.assigned_reviewer_id = p_manager_id
          OR e.assigned_engineer_id = p_manager_id
          OR EXISTS (
            SELECT 1
            FROM public.team_members tm
            JOIN public.teams t
              ON t.id = tm.team_id
             AND t.organization_id = tm.organization_id
            WHERE tm.organization_id = e.organization_id
              AND tm.user_id = e.user_id
              AND t.manager_user_id = p_manager_id
          )
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.expense_manager_can_review(
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
      AND om.role = 'engineer'
      AND om.is_active = true
  )
  AND public.manager_expense_visible_to_user(e.id, v_uid);
$$;

CREATE OR REPLACE FUNCTION public.list_manager_pending_expenses(p_org_id uuid DEFAULT NULL)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT e.*
  FROM public.expenses e
  WHERE (p_org_id IS NULL OR e.organization_id = p_org_id)
    AND e.status::text IN ('submitted', 'edited', 'level_1_verified', 'level_2_verified')
    AND public.manager_expense_visible_to_user(e.id, auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
  ORDER BY e.updated_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.repair_expense_for_manager_review(p_org_id uuid DEFAULT NULL)
RETURNS TABLE (
  expense_id uuid,
  manager_user_id uuid,
  old_assigned_reviewer_id uuid,
  old_assigned_engineer_id uuid,
  new_assigned_reviewer_id uuid,
  new_assigned_engineer_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidate_rows AS (
    SELECT
      e.id,
      t.manager_user_id,
      e.assigned_reviewer_id,
      e.assigned_engineer_id
    FROM public.expenses e
    JOIN public.team_members tm
      ON tm.user_id = e.user_id
     AND tm.organization_id = e.organization_id
    JOIN public.teams t
      ON t.id = tm.team_id
     AND t.organization_id = tm.organization_id
    WHERE (p_org_id IS NULL OR e.organization_id = p_org_id)
      AND e.status::text IN ('level_1_verified', 'level_2_verified')
      AND t.manager_user_id IS NOT NULL
      AND (
        e.assigned_reviewer_id IS DISTINCT FROM t.manager_user_id
        OR e.assigned_engineer_id IS DISTINCT FROM t.manager_user_id
      )
  ),
  updated AS (
    UPDATE public.expenses e
    SET
      assigned_reviewer_id = c.manager_user_id,
      assigned_engineer_id = c.manager_user_id,
      updated_at = now()
    FROM candidate_rows c
    WHERE e.id = c.id
    RETURNING
      e.id AS expense_id,
      c.manager_user_id,
      c.assigned_reviewer_id AS old_assigned_reviewer_id,
      c.assigned_engineer_id AS old_assigned_engineer_id,
      e.assigned_reviewer_id AS new_assigned_reviewer_id,
      e.assigned_engineer_id AS new_assigned_engineer_id
  )
  SELECT
    u.expense_id,
    u.manager_user_id,
    u.old_assigned_reviewer_id,
    u.old_assigned_engineer_id,
    u.new_assigned_reviewer_id,
    u.new_assigned_engineer_id
  FROM updated u;
END;
$$;

REVOKE ALL ON FUNCTION public.manager_expense_visible_to_user(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manager_expense_visible_to_user(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.list_manager_pending_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.repair_expense_for_manager_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.repair_expense_for_manager_review(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 20 / 20: 20260530120000_fix_public_schema_grants_after_restore.sql
-- -----------------------------------------------------------------------------

-- Fix API role access after full pg_restore (anon/authenticated lose public schema USAGE).
-- Safe to run on restored projects; idempotent.

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 21: Rewrite Storage URLs + storage schema grant
-- =============================================================================

UPDATE public.attachments
SET file_url = replace(file_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE file_url LIKE '%briypgrgqagbexudarba%';

UPDATE public.organizations
SET logo_url = replace(logo_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE logo_url IS NOT NULL AND logo_url LIKE '%briypgrgqagbexudarba%';

GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
SELECT 'expenses' AS tbl, COUNT(*)::bigint AS cnt FROM public.expenses
UNION ALL SELECT 'attachments', COUNT(*) FROM public.attachments;

SELECT COUNT(*) AS attachments_still_old_project FROM public.attachments WHERE file_url LIKE '%briypgrgqagbexudarba%';
SELECT COUNT(*) AS receipt_files_in_storage FROM storage.objects WHERE bucket_id = 'receipts';