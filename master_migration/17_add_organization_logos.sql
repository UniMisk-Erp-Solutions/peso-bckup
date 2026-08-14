-- ============================================================================
-- MIGRATION: Add Organization Logo Support
-- ============================================================================
-- This migration adds logo support for organizations, allowing each organization
-- to have its own custom logo displayed in the application.
-- ============================================================================

-- ============================================================================
-- PART 1: ADD LOGO_URL COLUMN TO ORGANIZATIONS TABLE
-- ============================================================================

-- Add logo_url column to organizations table
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Add comment
COMMENT ON COLUMN public.organizations.logo_url IS 'URL to the organization logo image. Stored in organization-logos storage bucket.';

-- ============================================================================
-- PART 2: CREATE STORAGE BUCKET FOR ORGANIZATION LOGOS
-- ============================================================================

-- Create storage bucket for organization logos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'organization-logos',
  'organization-logos',
  true, -- Public bucket so logos can be accessed
  5242880, -- 5MB limit
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- PART 3: CREATE RLS POLICIES FOR ORGANIZATION LOGOS BUCKET
-- ============================================================================

-- Policy: Anyone can view organization logos (public bucket)
CREATE POLICY "Organization logos are publicly viewable"
ON storage.objects FOR SELECT
USING (bucket_id = 'organization-logos');

-- Policy: Authenticated users can upload logos for their organization
CREATE POLICY "Admins can upload logos for their organization"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'organization-logos'
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
      AND (storage.foldername(name))[1] = om.organization_id::text
  )
);

-- Policy: Admins can update logos for their organization
CREATE POLICY "Admins can update logos for their organization"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'organization-logos'
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
      AND (storage.foldername(name))[1] = om.organization_id::text
  )
)
WITH CHECK (
  bucket_id = 'organization-logos'
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
      AND (storage.foldername(name))[1] = om.organization_id::text
  )
);

-- Policy: Admins can delete logos for their organization
CREATE POLICY "Admins can delete logos for their organization"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'organization-logos'
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
      AND (storage.foldername(name))[1] = om.organization_id::text
  )
);

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Organization logos are now supported:
-- ✅ logo_url column added to organizations table
-- ✅ organization-logos storage bucket created (public, 5MB limit)
-- ✅ RLS policies allow admins to upload/update/delete their organization's logo
-- ✅ Logos are stored in format: organization-logos/{organization_id}/logo.{ext}
-- ============================================================================

