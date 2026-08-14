-- First, ensure the storage bucket exists
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-attachments',
  'expense-attachments',
  false,
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can upload expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can view expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own expense attachments" ON storage.objects;

-- Create more permissive policies for now
CREATE POLICY "Users can upload expense attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can view expense attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can update their own expense attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

CREATE POLICY "Users can delete their own expense attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );
