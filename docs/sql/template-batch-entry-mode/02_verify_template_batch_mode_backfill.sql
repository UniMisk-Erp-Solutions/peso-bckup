-- VERIFY: Post-migration backfill check
-- Run after 01_add_template_batch_entry_mode.sql.
-- All queries are read-only.

-- V1: Count templates that now have batch_entry_mode set
SELECT
  batch_entry_mode,
  COUNT(*) AS template_count
FROM expense_form_field_templates
GROUP BY batch_entry_mode
ORDER BY batch_entry_mode NULLS LAST;

-- V2: Confirm no template that had ask_once_per_batch assignments is still NULL
SELECT COUNT(*) AS missed_backfill_count
FROM expense_form_field_templates t
WHERE t.batch_entry_mode IS NULL
  AND EXISTS (
    SELECT 1
    FROM expense_category_form_fields a
    WHERE a.template_id = t.id
      AND a.ask_once_per_batch = true
  );
-- Expected: 0

-- V3: Sample of backfilled templates
SELECT
  t.id,
  t.name,
  t.batch_entry_mode,
  COUNT(a.id) AS assignment_count,
  SUM(CASE WHEN a.ask_once_per_batch THEN 1 ELSE 0 END) AS legacy_once_count
FROM expense_form_field_templates t
LEFT JOIN expense_category_form_fields a ON a.template_id = t.id
GROUP BY t.id, t.name, t.batch_entry_mode
HAVING t.batch_entry_mode = 'once_per_batch'
ORDER BY assignment_count DESC
LIMIT 20;
