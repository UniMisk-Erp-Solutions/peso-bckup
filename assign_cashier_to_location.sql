-- Script to assign cashiers to locations
-- This will fix the "No Cashier Assigned" error

-- Step 1: Check existing cashiers and their current assignments
SELECT 
  p.user_id,
  p.name as cashier_name,
  p.organization_id,
  p.cashier_assigned_location_id,
  loc.name as assigned_location_name,
  p.cashier_assigned_engineer_id
FROM profiles p
LEFT JOIN locations loc ON loc.id = p.cashier_assigned_location_id
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'cashier'
)
ORDER BY p.organization_id, p.name;

-- Step 2: Check locations that need cashiers
SELECT 
  loc.id as location_id,
  loc.name as location_name,
  loc.organization_id,
  COUNT(cashier_profile.user_id) as current_cashier_count
FROM locations loc
LEFT JOIN profiles cashier_profile ON (
  cashier_profile.cashier_assigned_location_id = loc.id
  AND cashier_profile.organization_id = loc.organization_id
  AND EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = cashier_profile.user_id AND ur.role = 'cashier'
  )
)
GROUP BY loc.id, loc.name, loc.organization_id
HAVING COUNT(cashier_profile.user_id) = 0
ORDER BY loc.organization_id, loc.name;

-- Step 3: ASSIGN CASHIER TO LOCATION
-- Replace the values below with actual IDs from your database
-- Format: UPDATE profiles SET cashier_assigned_location_id = 'LOCATION_ID' WHERE user_id = 'CASHIER_USER_ID';

-- Example for "Vijay Cross Road" location:
-- First, find a cashier in the same organization (80ab039f-f9e2-4c76-8b5b-e65b15d66af9)
-- Then run:
-- UPDATE profiles 
-- SET cashier_assigned_location_id = 'a6a533aa-6360-4d6e-b65d-cff97fa274fa'  -- Vijay Cross Road location_id
-- WHERE user_id = 'YOUR_CASHIER_USER_ID'  -- Replace with actual cashier user_id
--   AND organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9'  -- Same organization
--   AND EXISTS (
--     SELECT 1 FROM user_roles ur 
--     WHERE ur.user_id = profiles.user_id AND ur.role = 'cashier'
--   );

-- Step 4: After assigning, sync engineers with the cashier
-- This will automatically assign all engineers in that location to the cashier
-- SELECT sync_engineers_with_location_cashier('LOCATION_ID'::UUID);

-- Step 5: Verify the assignment worked
SELECT 
  loc.id,
  loc.name,
  loc.organization_id,
  cashier_profile.user_id as cashier_id,
  cashier_profile.name as cashier_name,
  COUNT(engineer_locations.engineer_id) as engineer_count
FROM locations loc
LEFT JOIN profiles cashier_profile ON (
  cashier_profile.cashier_assigned_location_id = loc.id
  AND cashier_profile.organization_id = loc.organization_id
  AND EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = cashier_profile.user_id AND ur.role = 'cashier'
  )
)
LEFT JOIN engineer_locations ON engineer_locations.location_id = loc.id
GROUP BY loc.id, loc.name, loc.organization_id, cashier_profile.user_id, cashier_profile.name
ORDER BY loc.organization_id, loc.name;

-- QUICK FIX: Assign first available cashier to each location (use with caution!)
-- This will assign the first cashier in each organization to the first location in that organization
-- Only run this if you want automatic assignment

/*
DO $$
DECLARE
  loc_record RECORD;
  cashier_user_id UUID;
BEGIN
  FOR loc_record IN 
    SELECT DISTINCT loc.id, loc.organization_id
    FROM locations loc
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.cashier_assigned_location_id = loc.id
        AND p.organization_id = loc.organization_id
        AND EXISTS (
          SELECT 1 FROM user_roles ur 
          WHERE ur.user_id = p.user_id AND ur.role = 'cashier'
        )
    )
  LOOP
    -- Find first available cashier in same organization
    SELECT p.user_id INTO cashier_user_id
    FROM profiles p
    WHERE p.organization_id = loc_record.organization_id
      AND p.cashier_assigned_location_id IS NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur 
        WHERE ur.user_id = p.user_id AND ur.role = 'cashier'
      )
    LIMIT 1;
    
    -- Assign cashier to location if found
    IF cashier_user_id IS NOT NULL THEN
      UPDATE profiles
      SET cashier_assigned_location_id = loc_record.id
      WHERE user_id = cashier_user_id;
      
      -- Sync engineers
      PERFORM sync_engineers_with_location_cashier(loc_record.id);
      
      RAISE NOTICE 'Assigned cashier % to location %', cashier_user_id, loc_record.id;
    END IF;
  END LOOP;
END $$;
*/

