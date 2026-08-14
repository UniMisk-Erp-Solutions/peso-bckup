-- Verification script for DOC-062 reusable sub-field sets
-- Run this AFTER applying the migration to confirm setup.
-- This file is READ-ONLY — it contains only SELECT statements.

-- 1. Tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('expense_form_field_branch_presets', 'organization_expense_field_layout_items');

-- 2. Indexes exist
SELECT indexname, tablename FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_preset_org', 'idx_preset_template', 'idx_preset_default',
    'uix_preset_one_default_per_template',
    'idx_layout_org_context', 'idx_layout_template'
  );

-- 3. RLS enabled
SELECT relname, relrowsecurity FROM pg_class
WHERE relname IN ('expense_form_field_branch_presets', 'organization_expense_field_layout_items');

-- 4. Policies exist
SELECT polname, polcmd, polroles FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('expense_form_field_branch_presets', 'organization_expense_field_layout_items');

-- 5. No duplicate default presets per org/template
SELECT organization_id, parent_template_id, count(*) AS default_count
FROM public.expense_form_field_branch_presets
WHERE is_default = true
GROUP BY organization_id, parent_template_id
HAVING count(*) > 1;

-- 6. Preset org matches parent template org
-- (templates are org-scoped via organization_id column)
SELECT p.id, p.name, p.organization_id AS preset_org, t.organization_id AS template_org
FROM public.expense_form_field_branch_presets p
JOIN public.expense_form_field_templates t ON t.id = p.parent_template_id
WHERE p.organization_id <> t.organization_id;

-- 7. field_schema is always a JSON array
SELECT id, name FROM public.expense_form_field_branch_presets
WHERE jsonb_typeof(field_schema) <> 'array';

-- 8. No blank preset names
SELECT id FROM public.expense_form_field_branch_presets
WHERE trim(name) = '';
