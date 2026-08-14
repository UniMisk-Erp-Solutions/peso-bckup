-- MIGRATION: Add batch_entry_mode to expense_form_field_templates
-- Timestamp: 20260716120000
-- Author: PEsoWise
-- DO NOT RUN IN PRODUCTION without DBA review.
-- Run via Supabase dashboard or supabase/migrations/20260716120000_template_batch_entry_mode.sql

BEGIN;

-- 1. Add the new column (nullable by default — new templates will set it explicitly)
ALTER TABLE expense_form_field_templates
  ADD COLUMN IF NOT EXISTS batch_entry_mode TEXT
    CHECK (batch_entry_mode IN ('once_per_batch', 'per_line'));

-- 2. Backfill: for each template that has ANY assignment with ask_once_per_batch = true,
--    set batch_entry_mode = 'once_per_batch'.
--    Templates with NO such assignment remain NULL (client falls back to per_line).
UPDATE expense_form_field_templates t
SET batch_entry_mode = 'once_per_batch'
WHERE EXISTS (
  SELECT 1
  FROM expense_category_form_fields a
  WHERE a.template_id = t.id
    AND a.ask_once_per_batch = true
)
AND t.batch_entry_mode IS NULL;

-- 3. Comment
COMMENT ON COLUMN expense_form_field_templates.batch_entry_mode IS
  'Controls whether this template is collected once per batch submission ("once_per_batch") or per expense line ("per_line"). NULL = per_line (legacy default). Supersedes the per-assignment ask_once_per_batch column on expense_category_form_fields.';

COMMIT;
