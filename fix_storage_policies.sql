-- Run this SQL in your Supabase Dashboard SQL Editor to fix storage issues

-- 1. Ensure the receipts bucket exists with proper configuration
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts',
  'receipts',
  true, -- Make it public for easier access
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png'];

-- 2. Drop existing receipts policies if they exist
DROP POLICY IF EXISTS "Users can view receipts for their viewable expenses" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their receipts" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their receipts" ON storage.objects;

-- 3. Create comprehensive policies for receipts bucket
CREATE POLICY "receipts_select_policy"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'receipts');

CREATE POLICY "receipts_insert_policy"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "receipts_update_policy"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "receipts_delete_policy"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

-- 4. Verify the bucket exists
SELECT id, name, public, file_size_limit, allowed_mime_types 
FROM storage.buckets 
WHERE id = 'receipts';
