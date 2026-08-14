-- =============================================================================
-- DOC-078 — Attachment soft deletion + multi-copy storage durability
--
-- NOT EXECUTED by the change that shipped this file. Apply manually.
--
-- Motivation (DOC-077 §5d): a receipt was physically deleted from an unversioned
-- bucket by a browser-issued storage.object.delete_many, 3m47s after upload. It had
-- no staging twin and no backup covered its lifetime. Removing an attachment must
-- never again destroy the only copy of the bytes.
--
-- This migration is additive only: no DROP, no data rewrite, no destructive DDL.
-- =============================================================================

-- 1 ── Soft-deletion + durability columns on attachments ----------------------

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS deleted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by        uuid,
  ADD COLUMN IF NOT EXISTS delete_reason     text,
  ADD COLUMN IF NOT EXISTS deletion_source   text,
  ADD COLUMN IF NOT EXISTS restored_at       timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by       uuid,
  ADD COLUMN IF NOT EXISTS durability_status text NOT NULL DEFAULT 'primary_only';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attachments_durability_status_check'
  ) THEN
    ALTER TABLE public.attachments
      ADD CONSTRAINT attachments_durability_status_check
      CHECK (durability_status IN (
        'staging', 'primary_only', 'archive_pending', 'protected',
        'degraded', 'missing', 'restored'
      ));
  END IF;
END $$;

-- Active attachments are the ones the expense UI shows.
CREATE INDEX IF NOT EXISTS attachments_active_idx
  ON public.attachments (expense_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS attachments_durability_status_idx
  ON public.attachments (durability_status)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.attachments.deleted_at IS
  'Soft deletion marker (DOC-078). Storage objects are retained; rows are never hard-deleted by ordinary removal.';
COMMENT ON COLUMN public.attachments.durability_status IS
  'staging | primary_only | archive_pending | protected | degraded | missing | restored';


-- 2 ── Per-copy storage inventory ---------------------------------------------

CREATE TABLE IF NOT EXISTS public.attachment_storage_copies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id   uuid NOT NULL REFERENCES public.attachments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  copy_role       text NOT NULL,
  provider        text NOT NULL DEFAULT 'supabase-storage',
  bucket_name     text NOT NULL,
  object_path     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  size_bytes      bigint,
  sha256          text,
  verified_at     timestamptz,
  last_checked_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachment_storage_copies_role_check
    CHECK (copy_role IN ('staging', 'primary', 'archive')),
  CONSTRAINT attachment_storage_copies_status_check
    CHECK (status IN ('pending', 'verified', 'missing', 'failed', 'quarantined')),
  CONSTRAINT attachment_storage_copies_path_not_empty
    CHECK (length(trim(object_path)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS attachment_storage_copies_location_uniq
  ON public.attachment_storage_copies (provider, bucket_name, object_path);

CREATE UNIQUE INDEX IF NOT EXISTS attachment_storage_copies_role_uniq
  ON public.attachment_storage_copies (attachment_id, copy_role, provider);

CREATE INDEX IF NOT EXISTS attachment_storage_copies_org_status_idx
  ON public.attachment_storage_copies (organization_id, status);

ALTER TABLE public.attachment_storage_copies ENABLE ROW LEVEL SECURITY;

-- Read-only for members of the owning organization. No client INSERT/UPDATE/DELETE:
-- copy rows are written exclusively by SECURITY DEFINER server operations.
DROP POLICY IF EXISTS attachment_storage_copies_select ON public.attachment_storage_copies;
CREATE POLICY attachment_storage_copies_select
  ON public.attachment_storage_copies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = auth.uid()
        AND m.organization_id = attachment_storage_copies.organization_id
        AND m.is_active = true
    )
  );

COMMENT ON TABLE public.attachment_storage_copies IS
  'One row per physical copy of a receipt (staging/primary/archive). Server-written only (DOC-078).';


-- 3 ── Soft delete ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.soft_delete_attachment(
  p_attachment_id uuid,
  p_reason text DEFAULT NULL,
  p_source text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_owner uuid;
  v_already timestamptz;
BEGIN
  IF p_attachment_id IS NULL THEN RETURN false; END IF;

  SELECT a.organization_id, e.user_id, a.deleted_at
    INTO v_org, v_owner, v_already
  FROM public.attachments a
  JOIN public.expenses e ON e.id = a.expense_id
  WHERE a.id = p_attachment_id;

  IF v_org IS NULL THEN RETURN false; END IF;

  -- Idempotent: already soft-deleted is a success, not an error.
  IF v_already IS NOT NULL THEN RETURN true; END IF;

  -- Caller must be an active member of the owning organization.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = v_org
      AND m.is_active = true
  ) AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.is_master_admin = true
  ) THEN
    RAISE EXCEPTION 'not authorized for this organization';
  END IF;

  UPDATE public.attachments
     SET deleted_at      = now(),
         deleted_by      = auth.uid(),
         delete_reason   = p_reason,
         deletion_source = COALESCE(p_source, 'unknown')
   WHERE id = p_attachment_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_attachment(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.soft_delete_attachment(uuid, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.soft_delete_attachment(uuid, text, text) IS
  'Hides an attachment without deleting the row or any storage object (DOC-078). Idempotent.';


-- 4 ── Restore ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.restore_soft_deleted_attachment(
  p_attachment_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF p_attachment_id IS NULL THEN RETURN false; END IF;

  SELECT a.organization_id INTO v_org
  FROM public.attachments a WHERE a.id = p_attachment_id;

  IF v_org IS NULL THEN RETURN false; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = v_org
      AND m.is_active = true
  ) AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.is_master_admin = true
  ) THEN
    RAISE EXCEPTION 'not authorized for this organization';
  END IF;

  -- Idempotent: restoring an active attachment is a no-op success.
  UPDATE public.attachments
     SET deleted_at    = NULL,
         restored_at   = now(),
         restored_by   = auth.uid()
   WHERE id = p_attachment_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.restore_soft_deleted_attachment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_soft_deleted_attachment(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.restore_soft_deleted_attachment(uuid) IS
  'Reverses soft_delete_attachment (DOC-078). Idempotent.';
