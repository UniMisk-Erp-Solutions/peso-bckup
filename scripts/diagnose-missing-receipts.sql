-- =============================================================================
-- Missing receipt previews — diagnostics.  READ ONLY (every statement is SELECT).
--
-- Context: some expenses preview their receipt fine, others show
-- "This file is no longer available in storage." Because only SOME fail, the
-- cause is per-object, not bucket/RLS/CORS (those would break every receipt).
--
-- Q1–Q3 answer the single failing file. Q4–Q6 answer the whole fleet.
-- Q6 is the decisive one: it says whether the bytes exist under a DIFFERENT
-- path (a fixable path bug) or do not exist at all (bytes genuinely lost).
-- =============================================================================


-- Q1 ── Does the reported file exist ANYWHERE in the receipts bucket? ---------
-- Searches by filename across every folder, so a file stored under the "wrong"
-- folder still shows up.
SELECT
  name                    AS actual_path_in_bucket,
  owner,
  created_at,
  metadata->>'size'       AS size_bytes,
  metadata->>'mimetype'   AS mime_type
FROM storage.objects
WHERE bucket_id = 'receipts'
  AND name LIKE '%1785434184415-grfx7vumcj6.jpeg';
-- 1 row  → the bytes ARE there; compare the path to Q2's file_url.
-- 0 rows → the bytes are NOT in storage; no front-end change can display it.


-- Q2 ── What does the attachment record point at? ----------------------------
SELECT
  a.id,
  a.expense_id,
  a.filename,
  a.content_type,
  a.uploaded_by,
  a.created_at,
  a.file_url,
  regexp_replace(split_part(a.file_url, '?', 1),
                 '^.*/storage/v1/object/(public/|sign/)?receipts/', '') AS recorded_object_key
FROM public.attachments a
WHERE a.file_url LIKE '%1785434184415-grfx7vumcj6.jpeg';
-- Compare recorded_object_key with Q1's actual_path_in_bucket.


-- Q3 ── Bucket configuration sanity check ------------------------------------
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'receipts';
-- Expect public = true. If false, that is a separate (whole-bucket) problem.


-- Q4 ── How widespread is this, by upload date? ------------------------------
WITH parsed AS (
  SELECT
    a.id,
    a.created_at,
    regexp_replace(split_part(a.file_url, '?', 1),
                   '^.*/storage/v1/object/(public/|sign/)?receipts/', '') AS object_key
  FROM public.attachments a
  WHERE a.file_url IS NOT NULL AND a.file_url <> ''
)
SELECT
  p.created_at::date        AS uploaded_on,
  count(*)                  AS attachment_rows,
  count(o.id)               AS bytes_present,
  count(*) - count(o.id)    AS bytes_missing
FROM parsed p
LEFT JOIN storage.objects o
  ON o.bucket_id = 'receipts' AND o.name = p.object_key
GROUP BY 1
ORDER BY 1 DESC;
-- A clean cut-off date (everything before X missing, after X present) means a
-- partial storage restore. Scattered misses mean per-upload failures instead.


-- Q5 ── The actual broken rows ------------------------------------------------
WITH parsed AS (
  SELECT
    a.id, a.expense_id, a.filename, a.uploaded_by, a.created_at,
    regexp_replace(split_part(a.file_url, '?', 1),
                   '^.*/storage/v1/object/(public/|sign/)?receipts/', '') AS object_key
  FROM public.attachments a
  WHERE a.file_url IS NOT NULL AND a.file_url <> ''
)
SELECT p.id, p.expense_id, p.filename, p.uploaded_by, p.created_at, p.object_key
FROM parsed p
LEFT JOIN storage.objects o
  ON o.bucket_id = 'receipts' AND o.name = p.object_key
WHERE o.id IS NULL
ORDER BY p.created_at DESC
LIMIT 200;


-- Q6 ── DECISIVE: are the "missing" files present under a different path? -----
-- Matches on filename only (last path segment), ignoring the folder.
WITH parsed AS (
  SELECT
    a.id, a.expense_id, a.created_at,
    regexp_replace(split_part(a.file_url, '?', 1),
                   '^.*/storage/v1/object/(public/|sign/)?receipts/', '') AS object_key
  FROM public.attachments a
  WHERE a.file_url IS NOT NULL AND a.file_url <> ''
),
missing AS (
  SELECT p.*
  FROM parsed p
  LEFT JOIN storage.objects o
    ON o.bucket_id = 'receipts' AND o.name = p.object_key
  WHERE o.id IS NULL
)
SELECT
  m.expense_id,
  m.object_key                                AS recorded_path,
  o2.name                                     AS found_at_different_path,
  o2.created_at                               AS object_created_at
FROM missing m
JOIN storage.objects o2
  ON o2.bucket_id = 'receipts'
 AND regexp_replace(o2.name, '^.*/', '') = regexp_replace(m.object_key, '^.*/', '')
ORDER BY m.created_at DESC
LIMIT 200;
-- ROWS RETURNED  → path bug. The bytes exist; the DB points at the wrong folder.
--                  Fixable in code and/or by correcting file_url. Send me this output.
-- ZERO ROWS      → the bytes are genuinely absent from storage for those rows.
--                  Only a re-upload (or a storage backup restore) can show them.


-- Q7 ── Orphan check in the other direction (context only) -------------------
-- Objects sitting in storage that no attachment row references — e.g. files
-- left behind in temp/ because the move to {expenseId}/ never completed.
SELECT
  o.name,
  o.created_at,
  o.metadata->>'size' AS size_bytes
FROM storage.objects o
WHERE o.bucket_id = 'receipts'
  AND o.name LIKE 'temp/%'
ORDER BY o.created_at DESC
LIMIT 100;
