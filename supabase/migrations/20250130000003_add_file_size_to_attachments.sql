-- Add file_size column to attachments table to track file sizes
-- This enables total size validation (10MB limit for all attachments)

-- Add file_size column if it doesn't exist
ALTER TABLE public.attachments
ADD COLUMN IF NOT EXISTS file_size BIGINT;

-- Add comment to explain the column
COMMENT ON COLUMN public.attachments.file_size IS 'File size in bytes. Used for total size validation (10MB limit for all attachments combined).';

