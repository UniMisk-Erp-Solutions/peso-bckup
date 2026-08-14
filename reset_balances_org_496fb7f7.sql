-- Reset ALL current balances to 0 for organization 496fb7f7-d789-44c9-9be8-675ddf186302
-- Only updates the balance column on profiles; no other data is changed.

-- Organization ID: 496fb7f7-d789-44c9-9be8-675ddf186302

-- 1) Preview: list profiles that will be updated
SELECT user_id, name, email, balance AS current_balance
FROM public.profiles
WHERE organization_id = '496fb7f7-d789-44c9-9be8-675ddf186302'
ORDER BY name;

-- 2) Reset all balances to 0 for this org
UPDATE public.profiles
SET balance = 0
WHERE organization_id = '496fb7f7-d789-44c9-9be8-675ddf186302';

-- 3) Verify: all balances should now be 0
SELECT user_id, name, email, balance
FROM public.profiles
WHERE organization_id = '496fb7f7-d789-44c9-9be8-675ddf186302'
ORDER BY name;
