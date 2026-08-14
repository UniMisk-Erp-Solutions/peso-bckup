-- Test script to verify storage is working
-- Run this after applying the storage policies fix

-- 1. Check if receipts bucket exists and is configured correctly
SELECT 
  id, 
  name, 
  public, 
  file_size_limit, 
  allowed_mime_types,
  created_at
FROM storage.buckets 
WHERE id = 'receipts';

-- 2. Check storage policies for receipts bucket
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'objects' 
  AND policyname LIKE '%receipts%'
ORDER BY policyname;

-- 3. Check if there are any existing files in receipts bucket
SELECT 
  id,
  bucket_id,
  name,
  owner,
  created_at,
  updated_at,
  metadata
FROM storage.objects 
WHERE bucket_id = 'receipts'
ORDER BY created_at DESC
LIMIT 10;

-- 4. Check attachments table for any existing records
SELECT 
  id,
  expense_id,
  filename,
  content_type,
  file_url,
  created_at
FROM public.attachments
ORDER BY created_at DESC
LIMIT 10;
