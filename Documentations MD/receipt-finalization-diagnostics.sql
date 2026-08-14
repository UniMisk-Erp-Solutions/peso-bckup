-- ============================================================
-- PesoWise — Receipt finalization diagnostics
-- Run in Supabase Studio → SQL Editor (read-only — no data is changed)
-- Replace <USER_ID> and <EXPENSE_ID> with the actual UUIDs before running.
-- ============================================================

-- 1. Inspect receipt objects for a user / expense.
--    Shows both temp and final objects. If a "temp" row still exists alongside
--    a "final" row for the same filename, the move completed but cleanup was skipped
--    (safe — the final path is the authoritative one).
--    If only the "temp" row exists after submission, the temporary-path fallback
--    was used and the file URL stored in the attachments table is the temp path.
SELECT
  bucket_id,
  name,
  owner_id,
  created_at,
  updated_at,
  metadata
FROM storage.objects
WHERE bucket_id = 'receipts'
  AND (
    name LIKE 'temp/<USER_ID>/%'
    OR name LIKE '<EXPENSE_ID>/%'
  )
ORDER BY created_at;

-- 2. Inspect attachment rows for one expense.
--    storage_path should be either "{expenseId}/{filename}" (finalized) or
--    "temp/{userId}/{filename}" (temporary_fallback). A bare filename (no "/")
--    or NULL indicates a pre-fix insertion that was never updated — these
--    attachments cannot be reliably fetched by edit mode or backup.
SELECT
  id,
  expense_id,
  filename,
  file_url,
  storage_path,
  content_type,
  file_size,
  created_at
FROM public.attachments
WHERE expense_id = '<EXPENSE_ID>'
ORDER BY created_at;

-- 3. Cross-check: find attachments whose storage_path points to a temp object.
--    After a successful submission, all attachments should either have a final
--    path ({expenseId}/{filename}) or a known temp-fallback path.
--    Rows here with storage_path LIKE 'temp/%' are intentional fallbacks — verify
--    the matching object still exists in storage.objects (query 1 above).
SELECT
  a.expense_id,
  a.filename,
  a.storage_path,
  a.created_at,
  CASE
    WHEN a.storage_path IS NULL THEN 'NULL — missing path'
    WHEN a.storage_path NOT LIKE '%/%' THEN 'BARE FILENAME — not resolvable'
    WHEN a.storage_path LIKE 'temp/%' THEN 'TEMP FALLBACK — check object still exists'
    ELSE 'FINAL PATH — expected'
  END AS path_status
FROM public.attachments a
WHERE a.expense_id = '<EXPENSE_ID>'
ORDER BY a.created_at;

-- 4. Count attachment path quality across the whole receipts table.
--    Use to assess scale of pre-fix bare-filename rows vs correctly pathed rows.
SELECT
  COUNT(*)                                                      AS total_rows,
  COUNT(*) FILTER (WHERE storage_path IS NULL)                  AS null_paths,
  COUNT(*) FILTER (WHERE storage_path IS NOT NULL
                     AND storage_path NOT LIKE '%/%')           AS bare_filename_paths,
  COUNT(*) FILTER (WHERE storage_path LIKE 'temp/%')            AS temp_fallback_paths,
  COUNT(*) FILTER (WHERE storage_path IS NOT NULL
                     AND storage_path LIKE '%/%'
                     AND storage_path NOT LIKE 'temp/%')        AS final_paths
FROM public.attachments;

-- 5. Inspect Storage RLS policies on the objects table.
--    Check that the authenticated user can read from the receipts bucket at both
--    the temp/{userId}/... and {expenseId}/... paths.
--    If "Receipts are accessible by owner" or similar SELECT policy is missing,
--    the .download() and .createSignedUrl() calls will fail with 403.
SELECT
  policyname,
  cmd,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
ORDER BY policyname;

-- 6. Inspect receipt bucket settings.
--    public = true: getPublicUrl() works without authentication.
--    file_size_limit should match the 50 MB cap raised in the frontend.
--    If file_size_limit < 52428800, the Storage gateway will reject large uploads
--    before the compress-upload edge function can reduce them.
SELECT
  id,
  public,
  file_size_limit,
  allowed_mime_types
FROM storage.buckets
WHERE id = 'receipts';

-- ============================================================
-- Interpreting results
-- ============================================================
--
-- Scenario: move returns 400 or 504 but attachment row has final path
--   → The finalization waterfall probed the final path after the gateway error
--     and found the object was already there. Normal — no action needed.
--
-- Scenario: attachment row has storage_path = 'temp/{userId}/{filename}'
--   → The temporary-path fallback fired. The file IS accessible at that path.
--   → Verify: does storage.objects show a row for that path? If yes, the
--     attachment URL works and the expense is safely submitted.
--   → No action needed unless you later want to finalize the path manually.
--
-- Scenario: attachment row has NULL or bare-filename storage_path
--   → Pre-fix row inserted before storage_path was added to the insert.
--   → The attachment URL (file_url) may still work if the public URL resolves.
--   → Do NOT UPDATE storage_path without first confirming the object exists.
--
-- Scenario: backup requests return 400 for temp/{userId}/{filename}
--   → The file was moved to {expenseId}/{filename} (finalized). The backup
--     was using a stale temp URL from payload.attachments at submit time.
--   → After this hotfix, backup reads from ReceiptFinalizationResult.fileUrl
--     (the confirmed final URL) instead of the stale temp URL.
--
-- ============================================================
-- Do NOT run UPDATE / DELETE statements here.
-- Do NOT add a unique index on (expense_id, storage_path) — see DOC-013.
-- Do NOT change the receipts bucket public/private setting.
-- ============================================================
