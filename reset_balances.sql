-- Reset balances for specific users in organization
-- Organization ID: 80ab039f-f9e2-4c76-8b5b-e65b15d66af9
-- Users: admin@bill.com and himanshupandya@pesowise.unimisk.com

-- Preview the affected rows before updating
SELECT id, email, name, balance, organization_id
FROM public.profiles
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9'
  AND email IN ('admin@bill.com', 'himanshupandya@pesowise.unimisk.com');

-- Reset balances to 0
UPDATE public.profiles
SET balance = 0
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9'
  AND email IN ('admin@bill.com', 'himanshupandya@pesowise.unimisk.com');

-- Verify the update
SELECT id, email, name, balance, organization_id
FROM public.profiles
WHERE organization_id = '80ab039f-f9e2-4c76-8b5b-e65b15d66af9'
  AND email IN ('admin@bill.com', 'himanshupandya@pesowise.unimisk.com');

