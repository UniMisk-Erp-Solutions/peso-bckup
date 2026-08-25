-- Found while building the admin submit-for-employee optional receipt
-- upload: the attachments TABLE already has an org-admin INSERT bypass
-- ("Admins can insert attachments in their org for restore"), but the
-- receipts STORAGE BUCKET's own INSERT policy (receipts_insert_policy on
-- storage.objects) does not — its non-temp branch requires
-- e.user_id = uid(), i.e. the uploader must be the expense's OWNER.
--
-- Since FileUpload.tsx uploads the file to storage BEFORE inserting the
-- attachments row, an admin uploading a receipt for an employee's
-- admin-submitted expense was rejected at the storage layer with "new row
-- violates row-level security policy" before ever reaching the (already
-- permissive) attachments table policy — confirmed live against the
-- backup instance while testing this feature.
--
-- Fix: add a third OR-branch mirroring the attachments table's own
-- admin-bypass pattern (org-scoped via organization_memberships,
-- role='admin', is_active=true) — additive only, the temp-upload and
-- owner-upload branches are reproduced unchanged.

DROP POLICY IF EXISTS "receipts_insert_policy" ON storage.objects;

CREATE POLICY "receipts_insert_policy" ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'receipts'
  AND auth.uid() IS NOT NULL
  AND (
    -- Temp upload path (ExpenseForm.tsx, expenseId="new"): the employee's
    -- own scratch space before an expense exists yet.
    (
      (storage.foldername(name))[1] = 'temp'
      AND (storage.foldername(name))[2] = (auth.uid())::text
      AND EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE organization_memberships.user_id = auth.uid()
          AND organization_memberships.is_active = true
      )
    )
    OR
    -- Owner upload path: the expense's own user_id uploading to
    -- {expenseId}/{filename}.
    EXISTS (
      SELECT 1 FROM expenses e
      JOIN organization_memberships om ON e.organization_id = om.organization_id
      WHERE (e.id)::text = (storage.foldername(objects.name))[1]
        AND e.user_id = auth.uid()
        AND om.user_id = auth.uid()
        AND om.is_active = true
    )
    OR
    -- Org-admin upload path (NEW): an org admin attaching a receipt to any
    -- expense in their organization, regardless of who owns it — mirrors
    -- the attachments table's existing admin-bypass policy exactly.
    EXISTS (
      SELECT 1 FROM expenses e
      JOIN organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE (e.id)::text = (storage.foldername(objects.name))[1]
    )
  )
);

COMMENT ON POLICY "receipts_insert_policy" ON storage.objects IS
  'Temp-upload and owner-upload branches unchanged. Added an org-admin branch mirroring the attachments table''s own admin-bypass policy, so an admin can attach a receipt to an expense they did not submit themselves (admin submit-for-employee optional upload).';
