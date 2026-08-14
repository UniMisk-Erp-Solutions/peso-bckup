-- Diagnostic function to check cashier assignment for an engineer
-- This helps debug why get_cashier_for_engineer might be returning NULL

CREATE OR REPLACE FUNCTION diagnose_cashier_assignment(
  engineer_user_id UUID
)
RETURNS TABLE (
  check_type TEXT,
  result TEXT,
  details JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  engineer_organization_id UUID;
  engineer_location_id UUID;
  cashier_user_id UUID;
  location_organization_id UUID;
BEGIN
  -- Check 1: Engineer profile exists and has organization
  SELECT organization_id INTO engineer_organization_id
  FROM public.profiles
  WHERE user_id = engineer_user_id
  LIMIT 1;
  
  IF engineer_organization_id IS NULL THEN
    RETURN QUERY SELECT 
      'engineer_profile'::TEXT,
      'MISSING'::TEXT,
      jsonb_build_object(
        'engineer_user_id', engineer_user_id,
        'issue', 'Engineer profile not found or has no organization_id'
      );
    RETURN;
  END IF;
  
  RETURN QUERY SELECT 
    'engineer_profile'::TEXT,
    'FOUND'::TEXT,
    jsonb_build_object(
      'engineer_user_id', engineer_user_id,
      'organization_id', engineer_organization_id
    );
  
  -- Check 2: Engineer location assignment
  SELECT el.location_id, loc.organization_id 
  INTO engineer_location_id, location_organization_id
  FROM public.engineer_locations el
  INNER JOIN public.locations loc ON el.location_id = loc.id
  WHERE el.engineer_id = engineer_user_id
    AND loc.organization_id = engineer_organization_id
  LIMIT 1;
  
  IF engineer_location_id IS NULL THEN
    RETURN QUERY SELECT 
      'engineer_location'::TEXT,
      'NOT_ASSIGNED'::TEXT,
      jsonb_build_object(
        'engineer_user_id', engineer_user_id,
        'issue', 'Engineer is not assigned to any location in their organization'
      );
  ELSE
    RETURN QUERY SELECT 
      'engineer_location'::TEXT,
      'ASSIGNED'::TEXT,
      jsonb_build_object(
        'engineer_user_id', engineer_user_id,
        'location_id', engineer_location_id,
        'location_organization_id', location_organization_id
      );
    
    -- Check 3: Cashier assigned to location
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
    
    IF cashier_user_id IS NULL THEN
      RETURN QUERY SELECT 
        'location_cashier'::TEXT,
        'NOT_FOUND'::TEXT,
        jsonb_build_object(
          'location_id', engineer_location_id,
          'issue', 'No cashier assigned to this location in the same organization'
        );
    ELSE
      RETURN QUERY SELECT 
        'location_cashier'::TEXT,
        'FOUND'::TEXT,
        jsonb_build_object(
          'location_id', engineer_location_id,
          'cashier_user_id', cashier_user_id
        );
      RETURN; -- Found cashier via location, exit early
    END IF;
  END IF;
  
  -- Check 4: Direct engineer assignment (fallback)
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
  
  IF cashier_user_id IS NULL THEN
    RETURN QUERY SELECT 
      'direct_cashier'::TEXT,
      'NOT_FOUND'::TEXT,
      jsonb_build_object(
        'engineer_user_id', engineer_user_id,
        'issue', 'No cashier directly assigned to this engineer in the same organization'
      );
  ELSE
    RETURN QUERY SELECT 
      'direct_cashier'::TEXT,
      'FOUND'::TEXT,
      jsonb_build_object(
        'engineer_user_id', engineer_user_id,
        'cashier_user_id', cashier_user_id
      );
  END IF;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION diagnose_cashier_assignment TO authenticated;

