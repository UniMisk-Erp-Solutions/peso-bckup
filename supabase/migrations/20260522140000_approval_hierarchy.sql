-- Optional per-org approval hierarchy: team_leader, executive, engineer (manager), admin.
-- Feature flags: approval_hierarchy, hierarchy_team_leader, hierarchy_executive
-- Requires: 20260522139900_app_role_add_hierarchy_roles.sql (app_role enum values) applied first.

-- 1. Org role display labels (Settings)
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS approval_hierarchy_role_labels jsonb;

COMMENT ON COLUMN public.organization_settings.approval_hierarchy_role_labels IS
  'Custom display labels for hierarchy roles: { "employee", "team_leader", "executive", "engineer", "admin" }.';

-- 3. Teams
CREATE TABLE IF NOT EXISTS public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  name text NOT NULL,
  team_leader_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  executive_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  manager_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  routing_mode text NOT NULL DEFAULT 'full'
    CHECK (routing_mode IN ('full', 'skip_to_manager', 'skip_to_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_teams_organization ON public.teams (organization_id);

CREATE TABLE IF NOT EXISTS public.team_members (
  team_id uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_one_team_per_user_per_org
  ON public.team_members (organization_id, user_id);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.team_members (user_id);

COMMENT ON TABLE public.teams IS 'Approval hierarchy teams; routing_mode controls tier skipping.';
COMMENT ON TABLE public.team_members IS 'Employee membership in a team (one team per user per org).';

-- 4. Expense workflow columns
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approval_tier text
    CHECK (approval_tier IS NULL OR approval_tier IN ('team_leader', 'executive', 'engineer', 'admin')),
  ADD COLUMN IF NOT EXISTS assigned_reviewer_id uuid REFERENCES auth.users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_assigned_reviewer
  ON public.expenses (assigned_reviewer_id)
  WHERE assigned_reviewer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_approval_tier
  ON public.expenses (organization_id, approval_tier, status)
  WHERE approval_tier IS NOT NULL;

COMMENT ON COLUMN public.expenses.approval_tier IS 'Current hierarchy tier when approval_hierarchy feature is enabled.';
COMMENT ON COLUMN public.expenses.assigned_reviewer_id IS 'User who must act at the current approval tier.';

-- 5. Sync user_roles when organization_memberships role changes
CREATE OR REPLACE FUNCTION public.sync_user_role_from_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.user_roles WHERE user_id = OLD.user_id AND role = OLD.role;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role THEN
    DELETE FROM public.user_roles WHERE user_id = NEW.user_id AND role = OLD.role;
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.user_id, NEW.role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_user_role_from_membership ON public.organization_memberships;
CREATE TRIGGER trg_sync_user_role_from_membership
  AFTER INSERT OR UPDATE OF role OR DELETE ON public.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_role_from_membership();

-- Backfill user_roles for existing memberships (idempotent)
INSERT INTO public.user_roles (user_id, role)
SELECT om.user_id, om.role
FROM public.organization_memberships om
WHERE om.is_active = true
ON CONFLICT (user_id, role) DO NOTHING;

-- 6. RLS: teams
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teams_select_org" ON public.teams;
CREATE POLICY "teams_select_org"
  ON public.teams FOR SELECT
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "teams_admin_all" ON public.teams;
CREATE POLICY "teams_admin_all"
  ON public.teams FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = teams.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = teams.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "team_members_select_org" ON public.team_members;
CREATE POLICY "team_members_select_org"
  ON public.team_members FOR SELECT
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "team_members_admin_all" ON public.team_members;
CREATE POLICY "team_members_admin_all"
  ON public.team_members FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = team_members.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = team_members.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- 7. RLS: hierarchy reviewers can update assigned expenses (verify tier / reject; no approve)
DROP POLICY IF EXISTS "Hierarchy reviewers can update assigned expenses" ON public.expenses;
CREATE POLICY "Hierarchy reviewers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_reviewer_id
    AND approval_tier IS NOT NULL
    AND status IN ('submitted', 'edited')
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
        AND (
          (om.role = 'team_leader' AND expenses.approval_tier = 'team_leader')
          OR (om.role = 'executive' AND expenses.approval_tier = 'executive')
        )
    )
  )
  WITH CHECK (
    auth.uid() = assigned_reviewer_id
    AND approval_tier IS NOT NULL
    AND status IN ('submitted', 'edited', 'rejected')
    AND status <> 'approved'
  );

-- 8. Extend correction logs visibility for assigned hierarchy reviewers
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
          OR ex.assigned_reviewer_id = auth.uid()
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

-- 9. Extend apply_expense_correction for hierarchy reviewers at their tier
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

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_org
      AND om.is_active = true
      AND e.assigned_reviewer_id = v_uid
      AND e.approval_tier IS NOT NULL
      AND (
        (om.role = 'team_leader' AND e.approval_tier = 'team_leader')
        OR (om.role = 'executive' AND e.approval_tier = 'executive')
      )
  ) INTO v_is_hierarchy_reviewer;

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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members TO authenticated;
