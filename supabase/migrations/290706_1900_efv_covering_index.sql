-- Covering index for expense_form_field_values bulk lookup.
-- Query pattern (EngineerReview, AdminPanel, Expenses, etc.):
--   SELECT expense_id, field_value, template_id, branch_field_id
--   WHERE organization_id = ? AND expense_id IN (100 IDs)
-- Before: sequential table scan → 3-8 seconds per request
-- After: index-only scan  → < 50 ms per request

CREATE INDEX IF NOT EXISTS idx_efv_org_expense_covering
  ON public.expense_form_field_values(organization_id, expense_id)
  INCLUDE (field_value, template_id, branch_field_id);

-- Template meta lookup (fetchTemplateMetaByIds): WHERE id IN (...) AND organization_id = ?
CREATE INDEX IF NOT EXISTS idx_eft_id_org
  ON public.expense_form_field_templates(id, organization_id)
  INCLUDE (name, field_key);

-- Branch meta lookup (fetchBranchMetaByIds): WHERE id IN (...) AND organization_id = ?
CREATE INDEX IF NOT EXISTS idx_efob_id_org
  ON public.expense_form_field_option_branches(id, organization_id)
  INCLUDE (name, field_key);
