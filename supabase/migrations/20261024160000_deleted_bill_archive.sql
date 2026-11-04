-- Deleted-bill archive. When anyone removes a bill from an expense (the cross in Receipt Attachments), the file already stays in
-- storage (soft delete). This migration also records WHO it belonged to, so it can be found by employee on the server:
-- employee ID/code, name, the expense (transaction number, amount, status), who deleted it and when.
--
--  * It lives in its own schema `bill_archive`, which is NOT exposed through the API: no website screen, admin or not, can read it.
--    Only people with direct database access see it.
--  * Rows are never removed by the application (a trigger refuses DELETE).
--  * Existing soft-deleted bills are copied in once (idempotent).
CREATE SCHEMA IF NOT EXISTS bill_archive;
REVOKE ALL ON SCHEMA bill_archive FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS bill_archive.deleted_bills (
  attachment_id      uuid PRIMARY KEY,
  organization_id    uuid,
  expense_id         uuid,
  transaction_number text,
  expense_amount     numeric,
  expense_status     text,
  employee_user_id   uuid,
  employee_code      text,
  employee_name      text,
  filename           text,
  content_type       text,
  file_size          bigint,
  bucket_id          text NOT NULL DEFAULT 'receipts',
  storage_path       text,
  uploaded_at        timestamptz,
  deleted_at         timestamptz,
  deleted_by         uuid,
  deleted_by_name    text,
  deletion_source    text,
  archived_at        timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON bill_archive.deleted_bills FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS deleted_bills_employee_idx ON bill_archive.deleted_bills (organization_id, employee_code);
CREATE INDEX IF NOT EXISTS deleted_bills_expense_idx ON bill_archive.deleted_bills (expense_id);

COMMENT ON TABLE bill_archive.deleted_bills IS
  'Every bill an employee removed from an expense, with the employee and expense details. Server-side only (schema not exposed to the API). The file itself stays in storage at bucket_id/storage_path.';

-- one place that builds the snapshot, used by the trigger and the backfill
CREATE OR REPLACE FUNCTION bill_archive.snapshot_deleted_bill(p_attachment_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, bill_archive AS $$
  INSERT INTO bill_archive.deleted_bills (
    attachment_id, organization_id, expense_id, transaction_number, expense_amount, expense_status,
    employee_user_id, employee_code, employee_name, filename, content_type, file_size, storage_path,
    uploaded_at, deleted_at, deleted_by, deleted_by_name, deletion_source)
  SELECT a.id, a.organization_id, a.expense_id, e.transaction_number, e.total_amount, e.status::text,
         e.user_id, p.employee_id::text, p.name, a.filename, a.content_type, a.file_size, a.storage_path,
         a.created_at, a.deleted_at, a.deleted_by, d.name, a.deletion_source
    FROM public.attachments a
    JOIN public.expenses e ON e.id = a.expense_id
    LEFT JOIN public.profiles p ON p.user_id = e.user_id
    LEFT JOIN public.profiles d ON d.user_id = a.deleted_by
   WHERE a.id = p_attachment_id AND a.deleted_at IS NOT NULL
  ON CONFLICT (attachment_id) DO NOTHING;
$$;
REVOKE ALL ON FUNCTION bill_archive.snapshot_deleted_bill(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION bill_archive.capture_deleted_bill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, bill_archive AS $$
BEGIN
  PERFORM bill_archive.snapshot_deleted_bill(NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION bill_archive.capture_deleted_bill() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS capture_deleted_bill ON public.attachments;
CREATE TRIGGER capture_deleted_bill
  AFTER UPDATE OF deleted_at ON public.attachments
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION bill_archive.capture_deleted_bill();

-- the archive is permanent: the application can never delete from it
CREATE OR REPLACE FUNCTION bill_archive.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bill_archive.deleted_bills rows are permanent';
END $$;
DROP TRIGGER IF EXISTS refuse_delete ON bill_archive.deleted_bills;
CREATE TRIGGER refuse_delete BEFORE DELETE ON bill_archive.deleted_bills FOR EACH ROW EXECUTE FUNCTION bill_archive.refuse_delete();

-- copy what was already soft-deleted before this migration
INSERT INTO bill_archive.deleted_bills (
  attachment_id, organization_id, expense_id, transaction_number, expense_amount, expense_status,
  employee_user_id, employee_code, employee_name, filename, content_type, file_size, storage_path,
  uploaded_at, deleted_at, deleted_by, deleted_by_name, deletion_source)
SELECT a.id, a.organization_id, a.expense_id, e.transaction_number, e.total_amount, e.status::text,
       e.user_id, p.employee_id::text, p.name, a.filename, a.content_type, a.file_size, a.storage_path,
       a.created_at, a.deleted_at, a.deleted_by, d.name, a.deletion_source
  FROM public.attachments a
  JOIN public.expenses e ON e.id = a.expense_id
  LEFT JOIN public.profiles p ON p.user_id = e.user_id
  LEFT JOIN public.profiles d ON d.user_id = a.deleted_by
 WHERE a.deleted_at IS NOT NULL
ON CONFLICT (attachment_id) DO NOTHING;

-- Images that were uploaded but never became part of a saved expense (for example: added on a new expense, then removed with the
-- cross before saving, or the form was abandoned). Their bytes stay in storage under temp/<employee user id>/<file>; this view names
-- the employee. It is computed from storage, so it needs no trigger and is always current. Same rule as above: server access only.
CREATE OR REPLACE VIEW bill_archive.unsaved_uploads AS
WITH saved AS (
  SELECT DISTINCT substring(a.storage_path FROM '[^/]+$') AS file_name
    FROM public.attachments a
   WHERE a.storage_path IS NOT NULL
)
SELECT p.employee_id::text            AS employee_code,
       p.name                         AS employee_name,
       p.organization_id              AS organization_id,
       split_part(o.name, '/', 2)::uuid AS employee_user_id,
       o.bucket_id                    AS bucket_id,
       o.name                         AS storage_path,
       split_part(o.name, '/', 3)     AS file_name,
       (o.metadata ->> 'size')::bigint AS file_size,
       o.created_at                   AS uploaded_at
  FROM storage.objects o
  LEFT JOIN public.profiles p ON p.user_id::text = split_part(o.name, '/', 2)
  LEFT JOIN saved s ON s.file_name = split_part(o.name, '/', 3)
 WHERE o.bucket_id = 'receipts'
   AND o.name LIKE 'temp/%'
   AND s.file_name IS NULL;
REVOKE ALL ON bill_archive.unsaved_uploads FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON VIEW bill_archive.unsaved_uploads IS
  'Uploaded images with no saved attachment (removed before saving / abandoned), by employee. Files are in storage at bucket_id/storage_path.';
