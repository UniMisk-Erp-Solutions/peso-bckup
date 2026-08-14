-- PREFLIGHT: Template-Level Batch Entry Mode
-- Run this READ-ONLY check BEFORE applying the migration.
-- DO NOT APPLY this file directly — it is diagnostic only.

-- Check 1: Confirm expense_form_field_templates table exists
SELECT COUNT(*) AS template_count FROM expense_form_field_templates;

-- Check 2: Confirm expense_category_form_fields table exists
SELECT COUNT(*) AS assignment_count FROM expense_category_form_fields;

-- Check 3: Confirm batch_entry_mode column does NOT yet exist (safe to add)
SELECT
  column_name,
  data_type
FROM information_schema.columns
WHERE table_name = 'expense_form_field_templates'
  AND column_name = 'batch_entry_mode';
-- Expected: 0 rows (column not yet present)

-- Check 4: Count of assignments that currently have ask_once_per_batch = true (legacy)
SELECT COUNT(*) AS legacy_once_per_batch_count
FROM expense_category_form_fields
WHERE ask_once_per_batch = true;

-- Check 5: Count of distinct templates used in ask_once_per_batch assignments
SELECT COUNT(DISTINCT template_id) AS distinct_template_count
FROM expense_category_form_fields
WHERE ask_once_per_batch = true;
