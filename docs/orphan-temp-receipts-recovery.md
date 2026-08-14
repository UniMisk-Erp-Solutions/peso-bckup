# Orphan temp receipts — recovery guide

When files remain under `receipts/temp/{user_id}/…` in Storage but no matching expense exists (or submit failed), use this workflow.

## What the temp list means

Path pattern: `temp/{user_uuid}/{timestamp}-{random}.{ext}`

| Signal | Likely cause |
|--------|----------------|
| Files uploaded **recently** (Jun 2026) | User uploaded receipts; submit failed, was rolled back, or expense row was deleted |
| Many files for **one user id** | Multiple failed attempts or abandoned form sessions |
| `lastModified` newer than `created_at` | Storage was restored/copied (e.g. Jun 13) — file bytes still exist |

The app fix (May/Jun 2026) **no longer deletes** expenses on attachment failure; new failures should leave a **draft** row plus a **local browser backup** on My Expenses.

## Step 1 — Map user IDs to employees

Run in Supabase SQL Editor:

```sql
-- Replace with user ids from storage.objects paths (segment after temp/)
WITH temp_users(user_id) AS (
  SELECT DISTINCT split_part(name, '/', 2)::uuid
  FROM storage.objects
  WHERE bucket_id = 'receipts'
    AND name LIKE 'temp/%'
)
SELECT
  tu.user_id,
  p.name,
  p.email,
  om.organization_id,
  COUNT(so.name) AS orphan_temp_files,
  MIN(so.created_at) AS oldest_upload,
  MAX(so.created_at) AS newest_upload
FROM temp_users tu
LEFT JOIN profiles p ON p.user_id = tu.user_id
LEFT JOIN organization_memberships om ON om.user_id = tu.user_id AND om.is_active = true
LEFT JOIN storage.objects so
  ON so.bucket_id = 'receipts'
  AND so.name LIKE 'temp/' || tu.user_id::text || '/%'
GROUP BY tu.user_id, p.name, p.email, om.organization_id
ORDER BY newest_upload DESC NULLS LAST;
```

## Step 2 — Check for draft/submitted rows for those users

```sql
SELECT e.id, e.user_id, p.email, e.title, e.status, e.total_amount, e.created_at
FROM expenses e
JOIN profiles p ON p.user_id = e.user_id
WHERE e.user_id IN (
  SELECT DISTINCT split_part(name, '/', 2)::uuid
  FROM storage.objects
  WHERE bucket_id = 'receipts' AND name LIKE 'temp/%'
)
AND e.created_at >= now() - interval '60 days'
ORDER BY e.created_at DESC;
```

If a **draft** exists → ask the user to open it from My Expenses or use **Submit again** from the local backup section.

## Step 3 — Compare to DB backup (deleted rows)

If Step 2 shows no row but backup `full_backup.sql` has an expense for that user/date:

1. Take a **fresh** production backup first.
2. Extract the missing `expenses` row (+ `attachments`, custom fields) from the older dump.
3. Re-insert selectively (do not full-restore production over live data).

RLS policy `Admins can insert expenses in their org for restore` supports admin-driven restore when needed.

## Step 4 — User resubmit (no DB row)

1. User opens **My Expenses → Saved on this device** (local 7-day backup).
2. Clicks **Submit again** — form prefills title, amount, dates, custom fields.
3. User re-attaches receipts if temp files were cleaned up (orphan temp paths may still work if files exist under `temp/{user_id}/`).

Admin can download a temp file from Storage for the user if the app cannot link it automatically.

## Step 5 — Cleanup (optional, after recovery)

Only after users have resubmitted or data was restored:

```sql
-- Preview count — do not delete until confirmed
SELECT COUNT(*) FROM storage.objects
WHERE bucket_id = 'receipts' AND name LIKE 'temp/%';
```

Use Storage UI or a scripted delete per user folder once confirmed orphaned.

## Prevention

- Deploy service worker v5 + ExpenseForm draft retention (committed).
- Local **7-day submitted backup** on My Expenses (browser).
- Schedule **daily** `full_backup.sql` + storage sync on Coolify.
