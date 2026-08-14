-- Update receipts bucket to allow PDF files in addition to images
-- This enables PDF uploads for bill attachments

-- Update the receipts bucket to allow PDFs
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
WHERE id = 'receipts';

-- Also update expense-attachments bucket if it exists
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
WHERE id = 'expense-attachments';

-- Update the validate_file_upload function to allow PDFs
CREATE OR REPLACE FUNCTION public.validate_file_upload(
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  -- Check file size (4MB for PDFs, 10MB for images)
  IF file_type = 'application/pdf' THEN
    IF file_size > 4194304 THEN -- 4MB for PDFs
      RAISE EXCEPTION 'PDF file size exceeds 4MB limit';
    END IF;
  ELSE
    IF file_size > 10485760 THEN -- 10MB for images
      RAISE EXCEPTION 'Image file size exceeds 10MB limit';
    END IF;
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

