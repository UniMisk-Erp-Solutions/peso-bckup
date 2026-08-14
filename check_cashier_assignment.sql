-- Script to check cashier assignment setup
-- Run this in your Supabase SQL editor to diagnose the issue

-- Step 1: Check if the updated function exists
SELECT 
  proname as function_name,
  pg_get_functiondef(oid) as function_definition
FROM pg_proc
WHERE proname = 'get_cashier_for_engineer';

-- Step 2: Check if diagnose function exists
SELECT 
  proname as function_name
FROM pg_proc
WHERE proname = 'diagnose_cashier_assignment';

-- Step 3: For a specific engineer (replace with actual engineer user_id)
-- Replace 'YOUR_ENGINEER_USER_ID' with the actual engineer's user_id
-- You can find this from the error message or from the profiles table

-- Example: Check for engineer with user_id
-- SELECT * FROM diagnose_cashier_assignment('YOUR_ENGINEER_USER_ID'::UUID);

-- Step 4: Check all engineers and their cashier assignments
SELECT 
  p.user_id as engineer_id,
  p.name as engineer_name,
  p.organization_id as engineer_org_id,
  el.location_id,
  loc.name as location_name,
  loc.organization_id as location_org_id,
  cashier_profile.user_id as cashier_id,
  cashier_profile.name as cashier_name,
  cashier_profile.cashier_assigned_location_id,
  cashier_profile.cashier_assigned_engineer_id
FROM profiles p
LEFT JOIN engineer_locations el ON el.engineer_id = p.user_id
LEFT JOIN locations loc ON loc.id = el.location_id
LEFT JOIN profiles cashier_profile ON (
  (cashier_profile.cashier_assigned_location_id = el.location_id 
   AND cashier_profile.organization_id = p.organization_id)
  OR 
  (cashier_profile.cashier_assigned_engineer_id = p.user_id
   AND cashier_profile.organization_id = p.organization_id)
)
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'engineer'
)
ORDER BY p.organization_id, p.name;

-- Step 5: Check all cashiers and their assignments
SELECT 
  p.user_id as cashier_id,
  p.name as cashier_name,
  p.organization_id,
  p.cashier_assigned_location_id,
  loc.name as assigned_location_name,
  p.cashier_assigned_engineer_id,
  engineer_profile.name as assigned_engineer_name
FROM profiles p
LEFT JOIN locations loc ON loc.id = p.cashier_assigned_location_id
LEFT JOIN profiles engineer_profile ON engineer_profile.user_id = p.cashier_assigned_engineer_id
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'cashier'
)
ORDER BY p.organization_id, p.name;

-- Step 6: Check for engineers without location assignments
SELECT 
  p.user_id,
  p.name,
  p.organization_id,
  COUNT(el.location_id) as location_count
FROM profiles p
LEFT JOIN engineer_locations el ON el.engineer_id = p.user_id
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'engineer'
)
GROUP BY p.user_id, p.name, p.organization_id
HAVING COUNT(el.location_id) = 0;

-- Step 7: Check for locations without cashiers
SELECT 
  loc.id,
  loc.name,
  loc.organization_id,
  COUNT(cashier_profile.user_id) as cashier_count
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
HAVING COUNT(cashier_profile.user_id) = 0;

