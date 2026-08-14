-- Add field to track which location a cashier is assigned to
-- This creates location-based zones: Location -> Cashier -> Engineers -> Employees
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS cashier_assigned_location_id UUID REFERENCES public.locations(id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_cashier_assigned_location 
  ON public.profiles(cashier_assigned_location_id);

-- Add comment
COMMENT ON COLUMN public.profiles.cashier_assigned_location_id IS 'Tracks which location a cashier is assigned to. All engineers in this location will be associated with this cashier.';

-- Function to automatically associate engineers with cashiers when assigned to a location
-- This function updates all engineers in a location to have their cashier_assigned_engineer_id
-- set to the cashier assigned to that location
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
BEGIN
  -- Find the cashier assigned to this location
  SELECT user_id INTO cashier_user_id
  FROM public.profiles
  WHERE cashier_assigned_location_id = location_id_param
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'cashier'
    )
  LIMIT 1;
  
  -- If a cashier is found, update all engineers in this location
  IF cashier_user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET cashier_assigned_engineer_id = cashier_user_id
    WHERE user_id IN (
      SELECT engineer_id
      FROM public.engineer_locations
      WHERE location_id = location_id_param
    )
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

-- Function to find cashier for an engineer based on location (prioritized) or direct assignment
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
BEGIN
  -- First, try to find cashier via location assignment
  -- Get the first location of this engineer
  SELECT location_id INTO engineer_location_id
  FROM public.engineer_locations
  WHERE engineer_id = engineer_user_id
  LIMIT 1;
  
  -- If engineer has a location, find cashier assigned to that location
  IF engineer_location_id IS NOT NULL THEN
    SELECT user_id INTO cashier_user_id
    FROM public.profiles
    WHERE cashier_assigned_location_id = engineer_location_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'cashier'
      )
    LIMIT 1;
  END IF;
  
  -- If no location-based cashier found, fallback to direct engineer assignment
  IF cashier_user_id IS NULL THEN
    SELECT user_id INTO cashier_user_id
    FROM public.profiles
    WHERE cashier_assigned_engineer_id = engineer_user_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'cashier'
      )
    LIMIT 1;
  END IF;
  
  RETURN cashier_user_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_cashier_for_engineer TO authenticated;

-- Trigger function to sync engineers when a cashier is assigned to a location
CREATE OR REPLACE FUNCTION trigger_sync_engineers_on_cashier_location_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Check if the user is a cashier (moved from WHEN clause since subqueries aren't allowed there)
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = NEW.user_id
      AND user_roles.role = 'cashier'
  ) THEN
    RETURN NEW; -- Not a cashier, skip
  END IF;
  
  -- If cashier_assigned_location_id changed, sync engineers
  IF (NEW.cashier_assigned_location_id IS DISTINCT FROM OLD.cashier_assigned_location_id) THEN
    -- Sync engineers in the new location
    IF NEW.cashier_assigned_location_id IS NOT NULL THEN
      PERFORM sync_engineers_with_location_cashier(NEW.cashier_assigned_location_id);
    END IF;
    
    -- If old location had a cashier, we might want to clear assignments
    -- But for now, we'll leave old assignments as-is for backward compatibility
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on profiles table
DROP TRIGGER IF EXISTS sync_engineers_on_cashier_location_change ON public.profiles;
CREATE TRIGGER sync_engineers_on_cashier_location_change
  AFTER UPDATE OF cashier_assigned_location_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_engineers_on_cashier_location_change();

-- Trigger function to sync engineers when an engineer is assigned to a location
CREATE OR REPLACE FUNCTION trigger_sync_engineer_on_location_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_user_id UUID;
BEGIN
  -- Find cashier assigned to this location
  SELECT user_id INTO cashier_user_id
  FROM public.profiles
  WHERE cashier_assigned_location_id = NEW.location_id
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = profiles.user_id
        AND user_roles.role = 'cashier'
    )
  LIMIT 1;
  
  -- If cashier exists, assign engineer to that cashier
  IF cashier_user_id IS NOT NULL THEN
    UPDATE public.profiles
    SET cashier_assigned_engineer_id = cashier_user_id
    WHERE user_id = NEW.engineer_id
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = profiles.user_id
          AND user_roles.role = 'engineer'
      );
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on engineer_locations table
DROP TRIGGER IF EXISTS sync_engineer_on_location_assignment ON public.engineer_locations;
CREATE TRIGGER sync_engineer_on_location_assignment
  AFTER INSERT ON public.engineer_locations
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_engineer_on_location_assignment();

-- Update the existing cashier_can_manage_employee function to also check location-based assignments
CREATE OR REPLACE FUNCTION cashier_can_manage_employee(
  cashier_user_id UUID,
  employee_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_engineer_id UUID;
  cashier_location_id UUID;
  employee_engineer_id UUID;
  employee_location_id UUID;
BEGIN
  -- Get the engineer assigned to the cashier (direct assignment)
  SELECT cashier_assigned_engineer_id INTO cashier_engineer_id
  FROM public.profiles
  WHERE user_id = cashier_user_id;
  
  -- Get the location assigned to the cashier
  SELECT cashier_assigned_location_id INTO cashier_location_id
  FROM public.profiles
  WHERE user_id = cashier_user_id;
  
  -- Get the engineer assigned to the employee
  SELECT reporting_engineer_id INTO employee_engineer_id
  FROM public.profiles
  WHERE user_id = employee_user_id;
  
  -- If cashier has no assignments, can manage all (backward compatibility)
  IF cashier_engineer_id IS NULL AND cashier_location_id IS NULL THEN
    RETURN TRUE;
  END IF;
  
  -- Check location-based assignment first (prioritized)
  IF cashier_location_id IS NOT NULL AND employee_engineer_id IS NOT NULL THEN
    -- Get the location of the employee's engineer
    SELECT location_id INTO employee_location_id
    FROM public.engineer_locations
    WHERE engineer_id = employee_engineer_id
      AND location_id = cashier_location_id
    LIMIT 1;
    
    IF employee_location_id IS NOT NULL THEN
      RETURN TRUE; -- Employee's engineer is in the same location as cashier
    END IF;
  END IF;
  
  -- Fallback to direct engineer assignment
  IF cashier_engineer_id IS NOT NULL THEN
    RETURN cashier_engineer_id = employee_engineer_id;
  END IF;
  
  RETURN FALSE;
END;
$$;

-- Grant execute permission on cashier_can_manage_employee (in case it didn't exist before)
GRANT EXECUTE ON FUNCTION cashier_can_manage_employee TO authenticated;

