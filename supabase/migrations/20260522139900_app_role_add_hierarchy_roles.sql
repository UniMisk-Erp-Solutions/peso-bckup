-- Add team_leader and executive to app_role.
-- MUST be in its own migration/transaction before 20260522140000_approval_hierarchy.sql.
-- PostgreSQL 55P04 if you ADD VALUE and reference new labels in the same transaction.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'app_role' AND e.enumlabel = 'team_leader'
  ) THEN
    ALTER TYPE public.app_role ADD VALUE 'team_leader';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'app_role' AND e.enumlabel = 'executive'
  ) THEN
    ALTER TYPE public.app_role ADD VALUE 'executive';
  END IF;
END $$;
