-- Simplify get_cashier_for_engineer to just match locations
-- Simple logic: Engineer location = Cashier location = Return that cashier

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
  
  -- Get the engineer's location (first location they're assigned to)
  SELECT el.location_id INTO engineer_location_id
  FROM public.engineer_locations el
  INNER JOIN public.locations loc ON el.location_id = loc.id
  WHERE el.engineer_id = engineer_user_id
    AND loc.organization_id = engineer_organization_id
  LIMIT 1;
  
  -- If engineer has a location, find cashier assigned to that SAME location
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
    
    -- If found, return immediately (location-based assignment takes priority)
    IF cashier_user_id IS NOT NULL THEN
      RETURN cashier_user_id;
    END IF;
  END IF;
  
  -- Fallback: Direct engineer assignment (for backward compatibility)
  -- Only if no location-based cashier was found
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
  
  RETURN cashier_user_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_cashier_for_engineer TO authenticated;

-- Alternative simpler function: Get cashier by matching locations directly
-- This is the core logic: If engineer location = cashier location, return cashier
CREATE OR REPLACE FUNCTION get_cashier_by_location_match(
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
  -- Get engineer's organization
  SELECT organization_id INTO engineer_organization_id
  FROM public.profiles
  WHERE user_id = engineer_user_id
  LIMIT 1;
  
  IF engineer_organization_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Get engineer's location
  SELECT el.location_id INTO engineer_location_id
  FROM public.engineer_locations el
  INNER JOIN public.locations loc ON el.location_id = loc.id
  WHERE el.engineer_id = engineer_user_id
    AND loc.organization_id = engineer_organization_id
  LIMIT 1;
  
  -- If engineer has no location, return NULL
  IF engineer_location_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Find cashier with the SAME location
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
  
  RETURN cashier_user_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_cashier_by_location_match TO authenticated;

