-- ============================================================
-- PesoWise — Production verification for batch-review RLS and attachment-path fixes
-- Run in Supabase Studio → SQL Editor (read-only — no data is changed)
-- ============================================================

-- 1. Confirm the expense_batches SELECT policy is present and includes the reviewer arm
SELECT
  policyname,
  cmd,
  roles,
  qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename  = 'expense_batches'
ORDER BY policyname;

-- Expected: one row named "Users can view own expense batches", cmd = SELECT,
-- qual contains assigned_reviewer_id. If the row is missing or qual lacks
-- assigned_reviewer_id, the RLS fix has NOT been applied.

-- 2. Confirm the supporting indexes exist
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'expenses'
  AND indexname IN (
    'idx_expenses_batch_assigned_engineer',
    'idx_expenses_batch_assigned_reviewer'
  )
ORDER BY indexname;

-- Expected: 2 rows. Missing rows mean the index DDL was not applied.

-- 3. Confirm storage_path column exists on attachments
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'attachments'
  AND column_name  = 'storage_path';

-- Expected: 1 row, data_type = 'text', is_nullable = 'YES'.

-- 4. Audit current storage_path state in attachments
SELECT
  COUNT(*)                                                            AS total_attachment_rows,
  COUNT(*) FILTER (WHERE storage_path IS NULL)                        AS null_paths,
  COUNT(*) FILTER (WHERE storage_path IS NOT NULL
                     AND btrim(storage_path) = '')                    AS empty_paths,
  COUNT(*) FILTER (WHERE storage_path IS NOT NULL
                     AND position('/' IN storage_path) = 0)           AS bare_filename_paths,
  COUNT(*) FILTER (WHERE storage_path LIKE 'temp/%')                  AS temp_paths,
  COUNT(*) FILTER (WHERE storage_path NOT LIKE 'temp/%'
                     AND storage_path IS NOT NULL
                     AND btrim(storage_path) <> ''
                     AND position('/' IN storage_path) > 0)           AS final_paths
FROM public.attachments;

-- Ideal after full migration adoption: bare_filename_paths = 0.
-- Legacy rows (before this fix) will show null_paths > 0 — this is expected and safe.

-- 5. Find any remaining duplicate (expense_id, storage_path) rows
SELECT
  expense_id,
  storage_path,
  COUNT(*) AS duplicate_count
FROM public.attachments
WHERE storage_path IS NOT NULL
GROUP BY expense_id, storage_path
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, expense_id;

-- Any rows here explain why CREATE UNIQUE INDEX uq_attachments_expense_storage_path
-- failed. The unique index must NOT be re-added until all duplicates are resolved.

-- 6. Confirm receipts bucket settings
SELECT
  id,
  public,
  file_size_limit,
  allowed_mime_types
FROM storage.buckets
WHERE id = 'receipts';

-- Verify: public = true, file_size_limit = 52428800 (50 MB) before claiming
-- that 50 MB uploads are supported end-to-end.
-- If file_size_limit is NULL or < 52428800, large uploads may be rejected by
-- the storage layer regardless of client-side checks.

-- ============================================================
-- Non-destructive recommendations (DO NOT RUN as SQL)
-- ============================================================
--
-- DO NOT add the unique index uq_attachments_expense_storage_path until:
--   a) query 5 above returns zero rows; AND
--   b) you have confirmed that every new attachment insert writes a full
--      bucket-relative path (not a bare filename).
--
-- DO NOT run `supabase migration repair` or mark the migration as applied
--   automatically. The migration `20260630085810` was manually run in
--   production as individual SQL statements. Reconcile with:
--     supabase migration list
--   and only mark it applied manually if Supabase CLI confirms it is absent
--   from the remote history AND the DDL has been confirmed via queries 1-3.
--
-- DO NOT run `supabase db push` until local and remote migration histories
--   are fully reconciled. The repo contains duplicate 14-digit timestamps
--   (20260529120000 ×2, 20260629120000 ×2, 20260630120000 ×2) which will
--   cause `db push` to behave unpredictably.
--
-- DO NOT claim 50 MB upload support until query 6 confirms
--   file_size_limit = 52428800 in the receipts bucket. The edge function
--   cap was raised in compress-upload/index.ts but the bucket-level limit
--   is a separate Supabase storage setting that must be changed via
--   Supabase Studio → Storage → receipts → Edit bucket.
