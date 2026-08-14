-- Performance indexes for large-tenant submit/attachment validation
-- The frontend + backend frequently do:
--  - attachments existence: where expense_id = ? (optionally + organization_id)
--  - attachment total size validation: where expense_id = ? (optionally + organization_id)
--
-- This keeps those queries index-friendly even when one organization has a huge history.

DO $$
BEGIN
  -- If the attachments table isn't present in this environment (e.g. migrations
  -- applied out-of-order), exit gracefully instead of failing the whole run.
  IF to_regclass('public.attachments') IS NULL THEN
    RAISE NOTICE 'Skipping attachments indexes: table public.attachments does not exist';
    RETURN;
  END IF;

  -- Always useful: narrow by expense_id
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_attachments_expense_id'
  ) THEN
    CREATE INDEX idx_attachments_expense_id
      ON public.attachments (expense_id);
  END IF;

  -- Only add the composite index if the column exists in this deployment
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attachments'
      AND column_name = 'organization_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'idx_attachments_org_expense_id'
    ) THEN
      CREATE INDEX idx_attachments_org_expense_id
        ON public.attachments (organization_id, expense_id);
    END IF;
  END IF;
END $$;

