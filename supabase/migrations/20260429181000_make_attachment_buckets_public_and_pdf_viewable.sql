-- Ensure attachment buckets are publicly viewable and support PDF files.
-- This keeps existing app behavior (public URLs) consistent across environments.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'receipts',
    'receipts',
    true,
    10485760,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']
  ),
  (
    'expense-attachments',
    'expense-attachments',
    true,
    10485760,
    ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']
  )
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
