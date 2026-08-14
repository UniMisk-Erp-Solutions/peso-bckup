-- Update file upload limits to 2MB max per file, 2MB combined (enforced client-side)
-- This migration updates storage bucket limits and the validate_file_upload function

-- 2MB in bytes
-- 2 * 1024 * 1024 = 2097152

-- Update receipts bucket file size limit
UPDATE storage.buckets
SET file_size_limit = 2097152
WHERE id = 'receipts';

-- Update expense-attachments bucket if it exists
UPDATE storage.buckets
SET file_size_limit = 2097152
WHERE id = 'expense-attachments';

-- Update organization-logos bucket if it exists (for logo uploads in Settings)
UPDATE storage.buckets
SET file_size_limit = 2097152
WHERE id = 'organization-logos';

-- Update the validate_file_upload function to enforce 2MB limit for all file types
CREATE OR REPLACE FUNCTION public.validate_file_upload(
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  -- Check file size (2MB max for all file types)
  IF file_size > 2097152 THEN
    RAISE EXCEPTION 'File size exceeds 2MB limit';
  END IF;
  
  -- Check file type (images and PDFs)
  IF file_type NOT IN ('image/jpeg', 'image/jpg', 'image/png', 'application/pdf') THEN
    RAISE EXCEPTION 'Only PNG, JPG image files and PDF files are allowed';
  END IF;
  
  -- Check file extension
  IF LOWER(SUBSTRING(file_name FROM '\.([^.]*)$')) NOT IN ('jpg', 'jpeg', 'png', 'pdf') THEN
    RAISE EXCEPTION 'File extension not allowed. Only PNG, JPG, and PDF files are supported';
  END IF;
  
  RETURN TRUE;
END;
$$;
