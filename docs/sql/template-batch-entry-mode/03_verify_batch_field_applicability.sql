-- VERIFY: Cross-check batch field applicability post-migration
-- Read-only. Verifies that template-level mode matches legacy per-assignment mode.

-- V4: Find any assignment where ask_once_per_batch disagrees with template.batch_entry_mode
-- These are edge cases — new assignments created after migration with conflicting settings.
SELECT
  a.id AS assignment_id,
  t.id AS template_id,
  t.name AS template_name,
  a.ask_once_per_batch AS legacy_mode,
  t.batch_entry_mode AS template_mode
FROM expense_category_form_fields a
JOIN expense_form_field_templates t ON t.id = a.template_id
WHERE (
  (a.ask_once_per_batch = true AND (t.batch_entry_mode IS NULL OR t.batch_entry_mode = 'per_line'))
  OR
  (a.ask_once_per_batch = false AND t.batch_entry_mode = 'once_per_batch')
)
ORDER BY a.id;

-- V5: Count distinct templates that would be deduped (same template in multiple categories)
SELECT
  t.id AS template_id,
  t.name,
  t.batch_entry_mode,
  COUNT(DISTINCT a.category_id) AS category_count
FROM expense_form_field_templates t
JOIN expense_category_form_fields a ON a.template_id = t.id
WHERE t.batch_entry_mode = 'once_per_batch'
GROUP BY t.id, t.name, t.batch_entry_mode
HAVING COUNT(DISTINCT a.category_id) > 1
ORDER BY category_count DESC;
