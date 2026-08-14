-- Add storage_path column to attachments table.
-- Stores the actual storage bucket path (may differ from the public file_url when
-- the file lives at a temp path because storage write operations timed out).
-- Required before the corresponding INSERT in ExpenseForm.tsx can write this field.

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

COMMENT ON COLUMN public.attachments.storage_path IS
  'Bucket-relative path of the file in the receipts bucket (e.g. temp/userId/filename.jpg or expenseId/filename.jpg). Populated on insert; used by edit mode to locate files that ended up at their temp path.';
