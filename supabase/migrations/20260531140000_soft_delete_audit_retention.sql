-- Soft-delete (deactivate) org members and expense categories — preserve expenses & audit history.
-- Hard DELETE of profiles/categories is no longer required for "removal" from the org.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

COMMENT ON COLUMN public.profiles.deactivated_at IS
  'When set, user is deactivated in this org; profile row kept for expense/audit history.';

-- Normalize expense_categories.active / is_active (some envs use is_active)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expense_categories' AND column_name = 'is_active'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expense_categories' AND column_name = 'active'
  ) THEN
    ALTER TABLE public.expense_categories RENAME COLUMN is_active TO active;
  END IF;
END $$;

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

COMMENT ON COLUMN public.expense_categories.deactivated_at IS
  'When set, category hidden from new expenses; expenses.category text retains the name for audit.';

CREATE OR REPLACE FUNCTION public.deactivate_organization_member(
  p_organization_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Only organization admins can deactivate members';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'User is not a member of this organization';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot deactivate your own account';
  END IF;

  -- Detach supervisors/cashiers pointing at this user (org-scoped)
  UPDATE public.profiles
  SET
    reporting_engineer_id = CASE
      WHEN reporting_engineer_id = p_user_id THEN NULL ELSE reporting_engineer_id
    END,
    assigned_cashier_id = CASE
      WHEN assigned_cashier_id = p_user_id THEN NULL ELSE assigned_cashier_id
    END,
    cashier_assigned_engineer_id = CASE
      WHEN cashier_assigned_engineer_id = p_user_id THEN NULL ELSE cashier_assigned_engineer_id
    END,
    updated_at = now()
  WHERE organization_id = p_organization_id
    AND (
      reporting_engineer_id = p_user_id
      OR assigned_cashier_id = p_user_id
      OR cashier_assigned_engineer_id = p_user_id
    );

  -- Clear reviewer/manager assignment on open expenses (keep expense rows)
  UPDATE public.expenses
  SET
    assigned_engineer_id = CASE
      WHEN assigned_engineer_id = p_user_id THEN NULL ELSE assigned_engineer_id
    END,
    assigned_reviewer_id = CASE
      WHEN assigned_reviewer_id = p_user_id THEN NULL ELSE assigned_reviewer_id
    END,
    updated_at = now()
  WHERE organization_id = p_organization_id
    AND (
      assigned_engineer_id = p_user_id
      OR assigned_reviewer_id = p_user_id
    );

  DELETE FROM public.engineer_locations WHERE engineer_id = p_user_id;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'team_members'
  ) THEN
    DELETE FROM public.team_members
    WHERE organization_id = p_organization_id AND user_id = p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'expense_submission_drafts'
  ) THEN
    DELETE FROM public.expense_submission_drafts
    WHERE organization_id = p_organization_id AND user_id = p_user_id;
  END IF;

  DELETE FROM public.notifications WHERE user_id = p_user_id;

  UPDATE public.organization_memberships
  SET is_active = false
  WHERE organization_id = p_organization_id AND user_id = p_user_id;

  UPDATE public.profiles
  SET
    is_active = false,
    deactivated_at = now(),
    updated_at = now()
  WHERE user_id = p_user_id
    AND organization_id = p_organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_organization_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_organization_member(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.deactivate_organization_member(uuid, uuid) IS
  'Soft-remove org member: deactivate membership/profile, keep expenses/audit_logs/attachments.';

CREATE OR REPLACE FUNCTION public.deactivate_expense_category(
  p_organization_id uuid,
  p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Only organization admins can deactivate categories';
  END IF;

  UPDATE public.expense_categories
  SET
    active = false,
    deactivated_at = now()
  WHERE id = p_category_id
    AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category not found in this organization';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.deactivate_expense_category(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_expense_category(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.deactivate_expense_category(uuid, uuid) IS
  'Hide category from new expenses; historical expenses keep expenses.category text.';

-- Expense submitter display: keep deactivated profile names for audit lists
CREATE OR REPLACE FUNCTION public.get_expense_submitter_profiles(
  p_organization_id uuid,
  p_user_ids uuid[]
)
RETURNS TABLE(
  user_id uuid,
  name text,
  email text,
  balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    uid AS user_id,
    CASE
      WHEN COALESCE(p.is_active, true) = false AND p.name IS NOT NULL THEN p.name || ' (Former)'
      ELSE COALESCE(
        p.name,
        mapped.name,
        nullif(trim(au.raw_user_meta_data->>'name'), ''),
        nullif(trim(au.raw_user_meta_data->>'full_name'), ''),
        initcap(replace(split_part(au.email, '@', 1), '.', ' '))
      )
    END AS name,
    COALESCE(p.email, mapped.email, au.email, '') AS email,
    COALESCE(p.balance, mapped.balance, 0::numeric) AS balance
  FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS uid
  LEFT JOIN public.profiles p
    ON p.user_id = uid
   AND p.organization_id = p_organization_id
  LEFT JOIN auth.users au ON au.id = uid
  LEFT JOIN LATERAL (
    SELECT p2.name, p2.email, p2.balance
    FROM public.profiles p2
    WHERE p2.organization_id = p_organization_id
      AND p2.employee_id IS NOT NULL
      AND trim(p2.employee_id) <> ''
      AND lower(trim(p2.employee_id)) = lower(
        substring(au.email from 'emp\.[^.]+\.([^.]+)\.')
      )
    LIMIT 1
  ) mapped ON p.user_id IS NULL
$$;

REVOKE ALL ON FUNCTION public.get_expense_submitter_profiles(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_submitter_profiles(uuid, uuid[]) TO authenticated, service_role;
