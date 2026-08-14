-- ============================================================================
-- FIX TRIGGER TO ASSIGN USERS TO ADMIN'S ORGANIZATION
-- ============================================================================
-- This updates handle_new_user() to better handle organization assignment
-- When an admin creates a user, we want to assign them to the admin's org
-- But since triggers don't have context, we'll make it assign to default org
-- and let the admin assignment function handle the correct org assignment

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_org_id UUID;
  user_org_id UUID;
BEGIN
  -- Try to get organization_id from user metadata (if set during user creation)
  -- This allows setting organization_id when creating users via Admin API
  -- Format: { "organization_id": "uuid-here", "name": "User Name" }
  IF NEW.raw_user_meta_data IS NOT NULL AND NEW.raw_user_meta_data->>'organization_id' IS NOT NULL THEN
    user_org_id := (NEW.raw_user_meta_data->>'organization_id')::UUID;
  END IF;

  -- If no organization_id in metadata, try to get default organization
  IF user_org_id IS NULL THEN
    SELECT id INTO default_org_id
    FROM public.organizations
    WHERE slug = 'default'
    LIMIT 1;
    
    IF default_org_id IS NOT NULL THEN
      user_org_id := default_org_id;
    END IF;
  END IF;

  -- Only create profile if we have an organization_id
  -- If no organization found, skip profile creation (will be handled manually via assign_user_to_organization)
  IF user_org_id IS NOT NULL THEN
    INSERT INTO public.profiles (user_id, name, email, organization_id, is_active)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'name', 'New User'),
      NEW.email,
      user_org_id,
      true
    )
    ON CONFLICT (user_id) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, profiles.name),
      email = COALESCE(EXCLUDED.email, profiles.email),
      organization_id = COALESCE(EXCLUDED.organization_id, profiles.organization_id),
      is_active = true;
    
    -- Also create organization membership with default 'employee' role
    -- This will be updated by assign_user_to_organization if called
    INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
    VALUES (user_org_id, NEW.id, 'employee', true)
    ON CONFLICT (organization_id, user_id) DO UPDATE SET
      is_active = true;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS 
'Automatically creates a profile when a new auth user is created. 
If organization_id is provided in user metadata, uses that.
Otherwise assigns to default organization if it exists.
If no organization exists, profile creation is skipped and must be done manually via assign_user_to_organization().
Note: When admins create users via the UI, assign_user_to_organization() should be called to assign correct org and role.';

