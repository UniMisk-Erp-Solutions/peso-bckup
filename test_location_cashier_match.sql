-- Test script to verify location-based cashier assignment
-- Step 0: List all engineers - pick one and use their user_id in the queries below
SELECT 
  p.user_id as engineer_id,
  p.name as engineer_name,
  p.email as engineer_email,
  p.organization_id as engineer_org_id,
  el.location_id,
  loc.name as location_name
FROM profiles p
LEFT JOIN engineer_locations el ON el.engineer_id = p.user_id
LEFT JOIN locations loc ON loc.id = el.location_id
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'engineer'
)
ORDER BY p.name;

-- Step 1: Check a specific engineer's location
-- Replace 'YOUR_ENGINEER_USER_ID_HERE' with an actual UUID from Step 0
SELECT 
  p.user_id as engineer_id,
  p.name as engineer_name,
  p.organization_id as engineer_org_id,
  el.location_id,
  loc.name as location_name,
  loc.organization_id as location_org_id
FROM profiles p
LEFT JOIN engineer_locations el ON el.engineer_id = p.user_id
LEFT JOIN locations loc ON loc.id = el.location_id
WHERE p.user_id = 'YOUR_ENGINEER_USER_ID_HERE'::UUID  -- Replace with actual engineer user_id from Step 0
  AND EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = p.user_id AND ur.role = 'engineer'
  );

-- Step 2: Check cashiers assigned to a specific location
-- Replace 'YOUR_LOCATION_ID_HERE' with location_id from Step 1
SELECT 
  p.user_id as cashier_id,
  p.name as cashier_name,
  p.organization_id as cashier_org_id,
  p.cashier_assigned_location_id,
  loc.name as assigned_location_name,
  loc.organization_id as location_org_id
FROM profiles p
LEFT JOIN locations loc ON loc.id = p.cashier_assigned_location_id
WHERE p.cashier_assigned_location_id = 'YOUR_LOCATION_ID_HERE'::UUID  -- Replace with location_id from Step 1
  AND EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = p.user_id AND ur.role = 'cashier'
  );

-- Step 3: List all cashiers and their assigned locations
SELECT 
  p.user_id as cashier_id,
  p.name as cashier_name,
  p.organization_id as cashier_org_id,
  p.cashier_assigned_location_id,
  loc.name as assigned_location_name,
  loc.organization_id as location_org_id
FROM profiles p
LEFT JOIN locations loc ON loc.id = p.cashier_assigned_location_id
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'cashier'
)
ORDER BY p.name;

-- Step 4: Direct test of the function (replace with engineer user_id from Step 0)
SELECT get_cashier_for_engineer('YOUR_ENGINEER_USER_ID_HERE'::UUID) as cashier_user_id;

-- Step 5: Test the simpler location match function (replace with engineer user_id from Step 0)
SELECT get_cashier_by_location_match('YOUR_ENGINEER_USER_ID_HERE'::UUID) as cashier_user_id;

-- Step 6: Full diagnostic (replace with engineer user_id from Step 0)
SELECT * FROM diagnose_cashier_assignment('YOUR_ENGINEER_USER_ID_HERE'::UUID);

-- Step 7: Quick check - Find all engineers and their matching cashiers by location
SELECT 
  p.user_id as engineer_id,
  p.name as engineer_name,
  el.location_id,
  loc.name as location_name,
  cashier_profile.user_id as cashier_id,
  cashier_profile.name as cashier_name,
  CASE 
    WHEN cashier_profile.user_id IS NOT NULL THEN '✅ MATCH'
    ELSE '❌ NO CASHIER'
  END as status
FROM profiles p
INNER JOIN engineer_locations el ON el.engineer_id = p.user_id
INNER JOIN locations loc ON loc.id = el.location_id
LEFT JOIN profiles cashier_profile ON (
  cashier_profile.cashier_assigned_location_id = el.location_id
  AND cashier_profile.organization_id = p.organization_id
  AND EXISTS (
    SELECT 1 FROM user_roles ur 
    WHERE ur.user_id = cashier_profile.user_id AND ur.role = 'cashier'
  )
)
WHERE EXISTS (
  SELECT 1 FROM user_roles ur 
  WHERE ur.user_id = p.user_id AND ur.role = 'engineer'
)
ORDER BY p.name;

