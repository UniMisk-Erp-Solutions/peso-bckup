-- ============================================================================
-- Update user-limit error message (already ran 20250305120000)
-- ============================================================================
-- Replaces the exception text in assign_user_to_organization and
-- check_organization_member_limit with the new user-facing message.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assign_user_to_organization(
  p_user_id UUID,
  p_organization_id UUID,
  p_role TEXT DEFAULT 'employee'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org_max_users INTEGER;
  current_count INTEGER;
  is_existing_member BOOLEAN;
BEGIN
  SELECT o.max_users INTO org_max_users
  FROM public.organizations o
  WHERE o.id = p_organization_id;

  IF org_max_users IS NOT NULL THEN
    SELECT COUNT(*) INTO current_count
    FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND is_active = true;

    SELECT EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE organization_id = p_organization_id AND user_id = p_user_id
    ) INTO is_existing_member;

    IF NOT is_existing_member AND current_count >= org_max_users THEN
      RAISE EXCEPTION 'The user limit for this organization has been reached. Please remove some existing users or contact us to upgrade your plan.';
    END IF;
  END IF;

  INSERT INTO public.profiles (user_id, name, email, organization_id, is_active)
  SELECT
    p_user_id,
    COALESCE((SELECT raw_user_meta_data->>'name' FROM auth.users WHERE id = p_user_id), 'New User'),
    (SELECT email FROM auth.users WHERE id = p_user_id),
    p_organization_id,
    true
  ON CONFLICT (user_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    is_active = true;

  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  VALUES (p_organization_id, p_user_id, p_role::text, true)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = EXCLUDED.role,
    is_active = true;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_organization_member_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org_max_users INTEGER;
  active_count INTEGER;
  effective_count INTEGER;
BEGIN
  IF (TG_OP = 'INSERT' AND COALESCE(NEW.is_active, true) != true)
    OR (TG_OP = 'UPDATE' AND (NEW.is_active != true OR OLD.is_active = true)) THEN
    RETURN NEW;
  END IF;

  SELECT o.max_users INTO org_max_users
  FROM public.organizations o
  WHERE o.id = NEW.organization_id;

  IF org_max_users IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::INTEGER INTO active_count
  FROM public.organization_memberships
  WHERE organization_id = NEW.organization_id AND is_active = true;

  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (OLD.is_active IS NOT true)) THEN
    effective_count := active_count + 1;
  ELSE
    effective_count := active_count;
  END IF;

  IF effective_count > org_max_users THEN
    RAISE EXCEPTION 'The user limit for this organization has been reached. Please remove some existing users or contact us to upgrade your plan.';
  END IF;

  RETURN NEW;
END;
$$;
