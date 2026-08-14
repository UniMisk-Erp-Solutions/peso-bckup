-- Migration: Add template-level batch_entry_mode to expense_form_field_templates
-- Created: 2026-07-16
-- Purpose: Move "ask once per batch" mode from per-assignment to per-template.
--   Template ID is the deduplication key, not category name.
--   Legacy ask_once_per_batch = true assignments are backfilled to batch_entry_mode = 'once_per_batch'.
-- DO NOT RUN without DBA approval. See docs/sql/template-batch-entry-mode/ for verification queries.

BEGIN;

ALTER TABLE expense_form_field_templates
  ADD COLUMN IF NOT EXISTS batch_entry_mode TEXT
    CHECK (batch_entry_mode IN ('once_per_batch', 'per_line'));

COMMENT ON COLUMN expense_form_field_templates.batch_entry_mode IS
  'Controls whether this template is collected once per batch ("once_per_batch") or per expense line ("per_line"). NULL = per_line (legacy default). Supersedes per-assignment ask_once_per_batch.';

-- Backfill from legacy assignments
UPDATE expense_form_field_templates t
SET batch_entry_mode = 'once_per_batch'
WHERE EXISTS (
  SELECT 1
  FROM expense_category_form_fields a
  WHERE a.template_id = t.id
    AND a.ask_once_per_batch = true
)
AND t.batch_entry_mode IS NULL;

COMMIT;
