-- Fix get_cashier_for_engineer function to filter by organization_id
-- This ensures location-based cashier assignment works correctly in multi-tenant setup

CREATE OR REPLACE FUNCTION get_cashier_for_engineer(
  engineer_user_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  cashier_user_id UUID;
  engineer_location_id UUID;
  engineer_organization_id UUID;
BEGIN
  -- Get the engineer's organization_id from their profile
  SELECT organization_id INTO engineer_organization_id
  FROM public.profiles
  WHERE user_id = engineer_user_id
  LIMIT 1;
  
  -- If engineer has no organization, return NULL
  IF engineer_organization_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- First, try to find cashier via location assignment
  -- Get the first location of this engineer (filtered by organization)
  SELECT el.location_id INTO engineer_location_id
  FROM public.engineer_locations el
  INNER JOIN public.locations loc ON el.location_id = loc.id
  WHERE el.engineer_id = engineer_user_id
    AND loc.organization_id = engineer_organization_id
  LIMIT 1;
  
  -- If engineer has a location, find cashier assigned to that location (same organization)
  IF engineer_location_id IS NOT NULL THEN
    SELECT p.user_id INTO cashier_user_id
    FROM public.profiles p
    WHERE p.cashier_assigned_location_id = engineer_location_id
      AND p.organization_id = engineer_organization_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.user_id
          AND ur.role = 'cashier'
      )
    LIMIT 1;
  END IF;
  
  -- If no location-based cashier found, fallback to direct engineer assignment (same organization)
  IF cashier_user_id IS NULL THEN
    SELECT p.user_id INTO cashier_user_id
    FROM public.profiles p
    WHERE p.cashier_assigned_engineer_id = engineer_user_id
      AND p.organization_id = engineer_organization_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.user_id
          AND ur.role = 'cashier'
      )
    LIMIT 1;
  END IF;
  
  RETURN cashier_user_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_cashier_for_engineer TO authenticated;

-- Also fix sync_engineers_with_location_cashier to filter by organization
CREATE OR REPLACE FUNCTION sync_engineers_with_location_cashier(
  location_id_param UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_user_id UUID;
  location_organization_id UUID;
BEGIN
  -- Get the organization_id of the location
  SELECT organization_id INTO location_organization_id
  FROM public.locations
  WHERE id = location_id_param
  LIMIT 1;
  
  -- If location has no organization, return early
  IF location_organization_id IS NULL THEN
    RETURN;
  END IF;
  
  -- Find the cashier assigned to this location (same organization)
  SELECT user_id INTO cashier_user_id
  FROM public.profiles
  WHERE cashier_assigned_location_id = location_id_param
    AND organization_id = location_organization_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'cashier'
    )
  LIMIT 1;
  
  -- If a cashier is found, update all engineers in this location (same organization)
  IF cashier_user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET cashier_assigned_engineer_id = cashier_user_id
    WHERE user_id IN (
      SELECT engineer_id
      FROM public.engineer_locations
      WHERE location_id = location_id_param
        AND organization_id = location_organization_id
    )
    AND organization_id = location_organization_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'engineer'
    );
  END IF;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION sync_engineers_with_location_cashier TO authenticated;

-- Also fix trigger_sync_engineer_on_location_assignment to filter by organization
CREATE OR REPLACE FUNCTION trigger_sync_engineer_on_location_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_user_id UUID;
  location_organization_id UUID;
BEGIN
  -- Get the organization_id of the location
  SELECT organization_id INTO location_organization_id
  FROM public.locations
  WHERE id = NEW.location_id
  LIMIT 1;
  
  -- If location has no organization, return early
  IF location_organization_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Find cashier assigned to this location (same organization)
  SELECT user_id INTO cashier_user_id
  FROM public.profiles
  WHERE cashier_assigned_location_id = NEW.location_id
    AND organization_id = location_organization_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'cashier'
    )
  LIMIT 1;
  
  -- If cashier exists, assign engineer to that cashier (same organization)
  IF cashier_user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET cashier_assigned_engineer_id = cashier_user_id
    WHERE user_id = NEW.engineer_id
      AND organization_id = location_organization_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'engineer'
      );
  END IF;
  
  RETURN NEW;
END;
$$;

