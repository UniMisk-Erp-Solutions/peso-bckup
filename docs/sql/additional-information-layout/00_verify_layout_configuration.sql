-- Verification script for DOC-062 additional information layout
-- Run this AFTER applying the migration to confirm setup.
-- This file is READ-ONLY — it contains only SELECT statements.

-- 1. Table exists
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'organization_expense_field_layout_items';

-- 2. Indexes exist
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_layout_org_context', 'idx_layout_template');

-- 3. RLS enabled
SELECT relname, relrowsecurity FROM pg_class
WHERE relname = 'organization_expense_field_layout_items';

-- 4. Policies exist
SELECT polname, polcmd FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'organization_expense_field_layout_items';

-- 5. No cross-organization layout leaks
SELECT li.id, li.organization_id AS layout_org, t.organization_id AS template_org
FROM public.organization_expense_field_layout_items li
JOIN public.expense_form_field_templates t ON t.id = li.parent_template_id
WHERE li.organization_id <> t.organization_id;

-- 6. All context values are valid
SELECT DISTINCT context FROM public.organization_expense_field_layout_items
WHERE context NOT IN ('review', 'detail');

-- 7. All display_style values are valid
SELECT DISTINCT display_style FROM public.organization_expense_field_layout_items
WHERE display_style NOT IN ('standard', 'compact', 'inline');
