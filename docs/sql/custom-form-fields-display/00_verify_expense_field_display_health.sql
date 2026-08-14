-- ============================================================
-- READ-ONLY health check: expense custom form field display
-- DO NOT execute via migrations — run manually in Supabase SQL editor
-- ============================================================

-- 1. Value rows with no surviving template AND no branch link (orphans)
--    These become legacy:<value_uuid> in the new identity model.
SELECT
  v.id          AS value_row_id,
  v.expense_id,
  v.organization_id,
  v.template_id,
  v.branch_field_id,
  v.field_value
FROM expense_form_field_values v
WHERE v.template_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM expense_form_field_templates t
    WHERE t.id = v.template_id
  )
ORDER BY v.created_at DESC
LIMIT 100;

-- 2. Value rows that reference a branch field with no surviving branch row
SELECT
  v.id          AS value_row_id,
  v.expense_id,
  v.organization_id,
  v.branch_field_id,
  v.field_value
FROM expense_form_field_values v
WHERE v.branch_field_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM expense_form_field_option_branches b
    WHERE b.id = v.branch_field_id
  )
ORDER BY v.created_at DESC
LIMIT 100;

-- 3. Templates whose show_on_review or show_on_detail flag is NULL
--    (defaults to true in code, but explicit false is needed for context filtering)
SELECT
  id,
  organization_id,
  name,
  field_key,
  show_on_review,
  show_on_detail
FROM expense_form_field_templates
WHERE show_on_review IS NULL
   OR show_on_detail IS NULL
ORDER BY organization_id, name
LIMIT 100;

-- 4. Check for duplicate template names within the same org
--    (name-based merge key is fragile when names collide)
SELECT
  organization_id,
  name,
  COUNT(*) AS duplicate_count
FROM expense_form_field_templates
GROUP BY organization_id, name
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC
LIMIT 50;

-- 5. organization_expense_form_fields rows with unrecognized field_key
--    Valid keys: category, title, destination, expense_date, purpose, amount
SELECT
  id,
  organization_id,
  field_key,
  label
FROM organization_expense_form_fields
WHERE field_key NOT IN ('category', 'title', 'destination', 'expense_date', 'purpose', 'amount')
ORDER BY organization_id
LIMIT 50;

-- 6. Expenses with field values but zero templates resolved
--    (potential data loss — user submitted custom fields but no template exists)
SELECT
  v.expense_id,
  v.organization_id,
  COUNT(*) AS value_count,
  SUM(CASE WHEN v.template_id IS NULL AND v.branch_field_id IS NULL THEN 1 ELSE 0 END) AS fully_orphaned
FROM expense_form_field_values v
GROUP BY v.expense_id, v.organization_id
HAVING SUM(CASE WHEN v.template_id IS NULL AND v.branch_field_id IS NULL THEN 1 ELSE 0 END) = COUNT(*)
ORDER BY v.organization_id
LIMIT 50;
