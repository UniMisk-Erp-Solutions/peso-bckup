-- ============================================================================
-- FIX SETTINGS TABLE UNIQUE CONSTRAINT FOR MULTI-TENANCY
-- ============================================================================
-- The settings table needs to allow the same key for different organizations
-- This migration updates the unique constraint to be (key, organization_id)

-- Drop the old unique constraint on key
ALTER TABLE public.settings 
DROP CONSTRAINT IF EXISTS settings_key_key;

-- Add new unique constraint on (key, organization_id)
ALTER TABLE public.settings 
ADD CONSTRAINT settings_key_org_unique UNIQUE (key, organization_id);

COMMENT ON CONSTRAINT settings_key_org_unique ON public.settings IS 
'Ensures each setting key is unique per organization, allowing the same key to exist in different organizations.';

