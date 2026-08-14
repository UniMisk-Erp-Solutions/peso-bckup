-- ============================================================================
-- MAX USERS PER ORGANIZATION (master admin control)
-- ============================================================================
-- Adds max_users to organizations, enforces limit in assign_user_to_organization
-- and via trigger on organization_memberships. Updates create_organization_with_admin.
-- ============================================================================

-- PART 1: Add max_users column to organizations
-- ----------------------------------------------------------------------------
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS max_users INTEGER DEFAULT 50;

-- Allow NULL = unlimited; otherwise must be >= 0 (0 = no new users)
ALTER TABLE public.organizations
DROP CONSTRAINT IF EXISTS organizations_max_users_check;

ALTER TABLE public.organizations
ADD CONSTRAINT organizations_max_users_check CHECK (max_users IS NULL OR max_users >= 0);

CREATE INDEX IF NOT EXISTS idx_organizations_max_users ON public.organizations(max_users) WHERE max_users IS NOT NULL;

COMMENT ON COLUMN public.organizations.max_users IS 'Max active members per org. NULL = unlimited. Enforced by assign_user_to_organization and trigger on organization_memberships.';

-- PART 2: assign_user_to_organization with limit check
-- ----------------------------------------------------------------------------
-- Create or replace so it exists in applied migrations and enforces max_users
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
  -- Resolve organization max_users (NULL = unlimited)
  SELECT o.max_users INTO org_max_users
  FROM public.organizations o
  WHERE o.id = p_organization_id;

  IF org_max_users IS NOT NULL THEN
    -- Count current active members
    SELECT COUNT(*) INTO current_count
    FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND is_active = true;

    -- If this user already has a row (maybe inactive), they are not "new" for the limit
    SELECT EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE organization_id = p_organization_id AND user_id = p_user_id
    ) INTO is_existing_member;

    -- When updating existing membership (reactivate or change role), don't count as extra
    IF NOT is_existing_member AND current_count >= org_max_users THEN
      RAISE EXCEPTION 'The user limit for this organization has been reached. Please remove some existing users or contact us to upgrade your plan.';
    END IF;
  END IF;

  -- Create or update profile with organization_id
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

  -- Create organization membership
  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  VALUES (p_organization_id, p_user_id, p_role::text, true)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = EXCLUDED.role,
    is_active = true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_user_to_organization(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_user_to_organization(UUID, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.assign_user_to_organization(UUID, UUID, TEXT) IS
'Assigns an existing user to an organization. Enforces organization max_users limit. Creates profile and organization membership.';

-- PART 3: Trigger on organization_memberships to enforce limit on direct INSERT/UPDATE
-- ----------------------------------------------------------------------------
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
  -- Only enforce when we are adding an active member (INSERT or UPDATE setting is_active = true)
  IF (TG_OP = 'INSERT' AND COALESCE(NEW.is_active, true) != true)
    OR (TG_OP = 'UPDATE' AND (NEW.is_active != true OR OLD.is_active = true)) THEN
    RETURN NEW;
  END IF;

  SELECT o.max_users INTO org_max_users
  FROM public.organizations o
  WHERE o.id = NEW.organization_id;

  IF org_max_users IS NULL THEN
    RETURN NEW;  /* unlimited */
  END IF;

  /* Current active count (in BEFORE trigger, table state excludes NEW for INSERT; for UPDATE row still has OLD values) */
  SELECT COUNT(*)::INTEGER INTO active_count
  FROM public.organization_memberships
  WHERE organization_id = NEW.organization_id AND is_active = true;

  /* When adding one active: INSERT or UPDATE from inactive to active, effective = count + 1; else same */
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

DROP TRIGGER IF EXISTS enforce_organization_member_limit ON public.organization_memberships;
CREATE TRIGGER enforce_organization_member_limit
  BEFORE INSERT OR UPDATE OF is_active ON public.organization_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.check_organization_member_limit();

-- PART 4: Update create_organization_with_admin to set max_users
-- ----------------------------------------------------------------------------
-- Default new orgs to 50; plan-based could be added later (e.g. free-trial=5, pro=50)
CREATE OR REPLACE FUNCTION create_organization_with_admin(
  org_name TEXT,
  org_slug TEXT,
  plan_slug TEXT,
  admin_email TEXT,
  admin_name TEXT,
  admin_password TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id UUID;
  new_user_id UUID;
  plan_record RECORD;
  existing_user_id UUID;
  initial_max_users INTEGER;
BEGIN
  IF NOT is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can create organizations';
  END IF;

  SELECT * INTO plan_record
  FROM subscription_plans
  WHERE slug = plan_slug AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid plan: %', plan_slug;
  END IF;

  IF EXISTS (SELECT 1 FROM organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization slug already exists: %', org_slug;
  END IF;

  -- Plan-based default: free-trial = 5, pro = 50
  initial_max_users := CASE plan_slug
    WHEN 'free-trial' THEN 5
    WHEN 'starter' THEN 10
    ELSE 50
  END;

  INSERT INTO organizations (
    name,
    slug,
    plan,
    subscription_status,
    payment_status,
    is_active,
    subscription_start_date,
    max_users
  )
  VALUES (
    org_name,
    org_slug,
    plan_slug,
    'active',
    CASE WHEN plan_slug = 'free-trial' THEN 'active' ELSE 'pending' END,
    true,
    NOW(),
    initial_max_users
  )
  RETURNING id INTO new_org_id;

  SELECT id INTO existing_user_id
  FROM auth.users
  WHERE email = admin_email
  LIMIT 1;

  IF existing_user_id IS NOT NULL THEN
    new_user_id := existing_user_id;
  ELSE
    RAISE NOTICE 'User does not exist. Please create auth user first or use Supabase Admin API.';
    RETURN new_org_id;
  END IF;

  INSERT INTO public.profiles (user_id, name, email, organization_id)
  VALUES (new_user_id, admin_name, admin_email, new_org_id)
  ON CONFLICT (user_id) DO UPDATE SET
    organization_id = new_org_id,
    name = admin_name,
    email = admin_email;

  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  VALUES (new_org_id, new_user_id, 'admin', true)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = 'admin',
    is_active = true;

  INSERT INTO public.organization_settings (
    organization_id,
    engineer_approval_limit,
    attachment_required_above_amount
  )
  VALUES (
    new_org_id,
    50000,
    50
  )
  ON CONFLICT (organization_id) DO NOTHING;

  RETURN new_org_id;
END;
$$;

-- PART 5: RPC for master admin dashboard – get member counts per org
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_organization_member_counts(org_ids UUID[] DEFAULT NULL)
RETURNS TABLE(organization_id UUID, member_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om.organization_id, COUNT(*)::BIGINT
  FROM public.organization_memberships om
  WHERE om.is_active = true
    AND (org_ids IS NULL OR om.organization_id = ANY(org_ids))
  GROUP BY om.organization_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_member_counts(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_organization_member_counts(UUID[]) TO service_role;

COMMENT ON FUNCTION public.get_organization_member_counts(UUID[]) IS
'Returns active member count per organization. If org_ids is NULL, returns counts for all orgs. Used by master admin dashboard.';
