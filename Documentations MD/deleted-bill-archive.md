# Deleted-bill archive (server-side only)

**Doc ID:** DOC-148  
**Status:** in progress (migration written and tested; not yet applied to a live database)  
**Last updated:** 2026-10-24  
**Owner / area:** expenses, attachments (Receipt Attachments cross button)

## Summary
When an employee (or anyone) removes a bill with the cross in *Receipt Attachments*, the file already stays in storage (soft delete).
This change also records, permanently, whose bill it was: employee ID/code, name, the expense (transaction number, amount, status),
who deleted it and when, the file name and its storage path. It is readable **only with direct database/server access**: no website
screen (admin or otherwise) shows it, and the API roles have no privileges on it.

## Problem / requirement
Bills above the organisation's limit were deleted after submitting (21 files on 16 expenses in MicroLink, found 2026-10-24). The files
were still in storage but only traceable through joins. Requirement: keep every removed bill with the employee's details, never show it
in the website, and let someone with server access find it by employee.

## Solution
- New schema `bill_archive` (not exposed through PostgREST; all privileges revoked from `anon`, `authenticated`, `service_role`).
- Table `bill_archive.deleted_bills` (one row per removed attachment) filled by trigger `capture_deleted_bill` on `public.attachments`
  when `deleted_at` goes from NULL to a value.
- Trigger `refuse_delete`: the application cannot delete archive rows.
- One-time backfill of every attachment already soft-deleted.
- View `bill_archive.unsaved_uploads`: images that were uploaded but never became part of a saved expense (added on a new expense, then removed
  with the cross or abandoned before saving). They stay in storage under `temp/<employee user id>/<file>`; the view names the employee
  (code, name, organisation), the file and its storage path. Computed from storage, no trigger. In the restored backup this is about 1,959 images.
- The file itself is not moved: it stays at `bucket_id/storage_path` (bucket `receipts`).

## How to look a bill up (server access only)
```sql
select employee_code, employee_name, transaction_number, expense_amount, filename, storage_path, deleted_at, deleted_by_name
  from bill_archive.deleted_bills where employee_code = '1001' order by deleted_at desc;
```
The image is the object `receipts/<storage_path>` in the storage service (MinIO volume `stub/storage-single-tenant/receipts/<storage_path>`).

## No clash with submitted expenses
- The archive is a separate schema; it never writes to `expenses` or `attachments` and the website never reads it.
- A removed bill keeps its `attachments` row (soft delete) exactly as before; the bill-above-limit submit check counts live attachments only, so it is unchanged.
- Recording is wrapped so a failure only logs a warning and never blocks the delete (`20261024170000_deleted_bill_archive_never_blocks.sql`).
- A temp image that later becomes a saved attachment leaves the `unsaved_uploads` list automatically.
- Checked on the backup database with a rolled-back delete: archive +1, expense row untouched, nothing left behind after rollback.

## Key files
- `supabase/migrations/20261024160000_deleted_bill_archive.sql`
- `supabase/migrations/20261024170000_deleted_bill_archive_never_blocks.sql`
- `supabase/tests/bill_archive/archive_acceptance.mjs` (11 checks)

## Database / migrations
`20261024160000_deleted_bill_archive.sql` (run manually; idempotent).

## Test plan
`node supabase/tests/bill_archive/archive_acceptance.mjs` (needs `@electric-sql/pglite`): backfill, trigger, no duplicates, DELETE refused,
website roles have no access.

## Finding unsaved uploads (server access only)
```sql
select employee_code, employee_name, file_name, file_size, uploaded_at, storage_path
  from bill_archive.unsaved_uploads where employee_code = '1001' order by uploaded_at desc;
```

## Not covered
- The purge of expired trashed expenses (`purge_expired_trashed_expenses_v1`) can still remove storage bytes of expenses that are purged.
- Deleting the last bill of an above-limit expense is still allowed (separate decision).

## Revision log
| Date | Notes |
|---|---|
| 2026-10-24 | Created. Migration and test written; applied nowhere yet. |
| 2026-10-24 | Added trigger hardening (never blocks the real delete) and the 'no clash' section. |
| 2026-10-24 | Added view `unsaved_uploads` for images removed or abandoned before the expense was saved. |
