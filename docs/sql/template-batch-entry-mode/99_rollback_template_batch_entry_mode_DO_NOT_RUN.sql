-- ROLLBACK: Remove batch_entry_mode from expense_form_field_templates
-- WARNING: DO NOT RUN unless explicitly authorized by DBA.
-- This is a destructive column drop. Existing batch_entry_mode values will be lost.
-- After rollback, the system falls back to per-assignment ask_once_per_batch (legacy).

BEGIN;

ALTER TABLE expense_form_field_templates
  DROP COLUMN IF EXISTS batch_entry_mode;

COMMIT;
