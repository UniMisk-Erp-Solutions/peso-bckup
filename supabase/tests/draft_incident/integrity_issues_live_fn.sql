-- Verbatim copy of the LIVE Production definition (read via pg_get_functiondef, 2026-10-16).
-- The function is not defined in supabase/migrations (drift); it is used here ONLY to run the
-- DOC-148 acceptance test against the real validator logic. No data.
CREATE OR REPLACE FUNCTION public.expense_submission_integrity_issues_v1(p_expense_id uuid)
 RETURNS TABLE(expense_id uuid, issue_code text, issue_source text, severity text, field_label text, field_key text, template_id uuid, branch_field_id uuid, sort_order integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org         uuid;
  v_category    text;
  v_category_id uuid;
  r             record;
  k             text;
  v_value       text;
  v_defs        integer;
  v_seq         integer := 0;
  v_assignment  record;
  v_show        boolean;
  v_required    boolean;
  v_tvalue      text;
  v_branch      record;
BEGIN
  SELECT e.organization_id, e.category::text
    INTO v_org, v_category
  FROM public.expenses e WHERE e.id = p_expense_id;

  IF v_org IS NULL THEN
    RETURN;                       -- expense gone; nothing to report
  END IF;

  -- ── (A) ORGANIZATION MANDATORY FIELDS ──────────────────────────────────────
  -- Mirrors validate_expense_org_required_fields_v1 exactly.
  IF EXISTS (SELECT 1 FROM public.organization_required_expense_fields p
              WHERE p.organization_id = v_org AND p.required) THEN
    FOR r IN
      SELECT p.template_id, p.required_branch_field_keys, t.name AS template_name
      FROM public.organization_required_expense_fields p
      JOIN public.expense_form_field_templates t ON t.id = p.template_id
      WHERE p.organization_id = v_org AND p.required
      ORDER BY t.name
    LOOP
      -- (a) the parent option itself. Duplicate rows exist in historical data,
      --     so look for ANY non-blank value rather than an arbitrary first row.
      SELECT btrim(v.field_value) INTO v_value
      FROM public.expense_form_field_values v
      WHERE v.expense_id = p_expense_id
        AND v.template_id = r.template_id
        AND NULLIF(btrim(v.field_value), '') IS NOT NULL
      ORDER BY v.created_at DESC NULLS LAST
      LIMIT 1;

      IF v_value IS NULL THEN
        v_seq := v_seq + 1;
        RETURN QUERY SELECT p_expense_id, 'MISSING_REQUIRED_VALUE', 'organization_policy',
                            'user_fixable', r.template_name, NULL::text,
                            r.template_id, NULL::uuid, v_seq;
        CONTINUE;                 -- dependents are undefined without the parent
      END IF;

      -- (b) configuration, fail-closed: exactly ONE active definition per
      --     mandatory dependent key for the option actually selected.
      FOREACH k IN ARRAY r.required_branch_field_keys LOOP
        SELECT count(*) INTO v_defs
        FROM public.expense_form_field_option_branches b
        WHERE b.organization_id = v_org
          AND b.parent_template_id = r.template_id
          AND b.parent_option_value = v_value
          AND b.retired_at IS NULL
          AND b.field_key = k;

        IF v_defs <> 1 THEN
          v_seq := v_seq + 1;
          RETURN QUERY SELECT p_expense_id, 'INVALID_BRANCH_CONFIGURATION',
                              'organization_policy', 'configuration',
                              r.template_name || ' -> ' || k || ' (' || v_defs || ' active definitions)',
                              k, r.template_id, NULL::uuid, v_seq;
        END IF;
      END LOOP;

      -- (c) dependents active for the option actually selected.
      FOR v_branch IN
        SELECT b.id AS b_id, b.name AS b_name, b.field_key AS b_key
        FROM public.expense_form_field_option_branches b
        WHERE b.organization_id = v_org
          AND b.parent_template_id = r.template_id
          AND b.parent_option_value = v_value
          AND b.retired_at IS NULL
          AND (b.required OR b.field_key = ANY (r.required_branch_field_keys))
          AND NOT EXISTS (
            SELECT 1 FROM public.expense_form_field_values v2
            WHERE v2.expense_id = p_expense_id
              AND v2.branch_field_id = b.id
              AND NULLIF(btrim(v2.field_value), '') IS NOT NULL)
        ORDER BY b.display_order, b.name
      LOOP
        v_seq := v_seq + 1;
        RETURN QUERY SELECT p_expense_id, 'MISSING_REQUIRED_BRANCH', 'organization_policy',
                            'user_fixable', v_branch.b_name, v_branch.b_key,
                            r.template_id, v_branch.b_id, v_seq;
      END LOOP;
    END LOOP;
  END IF;

  -- ── (B) CATEGORY REQUIRED FIELDS ───────────────────────────────────────────
  -- Mirrors validate_expense_custom_fields_for_submission_v1 exactly.
  SELECT c.id INTO v_category_id
  FROM public.expense_categories c
  WHERE c.organization_id = v_org
    AND lower(c.name) = lower(COALESCE(v_category, ''))
  LIMIT 1;

  IF v_category_id IS NULL THEN
    RETURN;                       -- legacy/free-text category: nothing configured
  END IF;

  FOR v_assignment IN
    SELECT cff.template_id, cff.required AS a_required, cff.show_on_submit AS a_show,
           t.required AS t_required, t.show_on_submit AS t_show,
           t.name AS template_name, t.field_type
    FROM public.expense_category_form_fields cff
    JOIN public.expense_form_field_templates t ON t.id = cff.template_id
    WHERE cff.category_id = v_category_id
      AND cff.organization_id = v_org
    ORDER BY t.name, cff.template_id      -- deterministic; the original was unordered
  LOOP
    -- (submitFlag ?? templateSubmitFlag ?? true): a field never shown at submit
    -- time can never block submission.
    v_show := COALESCE(v_assignment.a_show, v_assignment.t_show, true);
    CONTINUE WHEN NOT v_show;

    -- assignment.required ?? template.required
    v_required := COALESCE(v_assignment.a_required, v_assignment.t_required, false);

    SELECT v.field_value INTO v_tvalue
    FROM public.expense_form_field_values v
    WHERE v.expense_id = p_expense_id
      AND v.template_id = v_assignment.template_id;

    IF v_required AND (v_tvalue IS NULL OR btrim(v_tvalue) = '') THEN
      v_seq := v_seq + 1;
      RETURN QUERY SELECT p_expense_id, 'MISSING_REQUIRED_VALUE', 'category_field',
                          'user_fixable', v_assignment.template_name, NULL::text,
                          v_assignment.template_id, NULL::uuid, v_seq;
    END IF;

    IF v_assignment.field_type = 'select'
       AND v_tvalue IS NOT NULL AND btrim(v_tvalue) <> '' THEN
      FOR v_branch IN
        WITH RECURSIVE branch_tree AS (
          SELECT b.id AS b_id, b.name AS b_name, b.field_key AS b_key,
                 b.required AS b_required, b.display_order AS b_order, 1 AS b_depth
          FROM public.expense_form_field_option_branches b
          WHERE b.organization_id = v_org
            AND b.parent_template_id = v_assignment.template_id
            AND b.parent_branch_id IS NULL
            AND b.parent_option_value = v_tvalue
            AND b.retired_at IS NULL
          UNION ALL
          SELECT child.id, child.name, child.field_key, child.required,
                 child.display_order, parent.b_depth + 1
          FROM public.expense_form_field_option_branches child
          JOIN branch_tree parent ON child.parent_branch_id = parent.b_id
          JOIN public.expense_form_field_values pv
            ON pv.branch_field_id = parent.b_id AND pv.expense_id = p_expense_id
          WHERE child.organization_id = v_org
            AND child.parent_option_value = pv.field_value
            AND child.retired_at IS NULL
            AND parent.b_depth < 3        -- MAX_CONDITIONAL_BRANCH_DEPTH
        )
        SELECT bt.b_id, bt.b_name, bt.b_key, bt.b_required, bt.b_order, bt.b_depth
        FROM branch_tree bt
        ORDER BY bt.b_depth, bt.b_order, bt.b_name
      LOOP
        IF v_branch.b_required AND NOT EXISTS (
             SELECT 1 FROM public.expense_form_field_values v
             WHERE v.expense_id = p_expense_id
               AND v.branch_field_id = v_branch.b_id
               AND v.field_value IS NOT NULL
               AND btrim(v.field_value) <> '') THEN
          v_seq := v_seq + 1;
          RETURN QUERY SELECT p_expense_id, 'MISSING_REQUIRED_BRANCH', 'category_field',
                              'user_fixable', v_branch.b_name, v_branch.b_key,
                              v_assignment.template_id, v_branch.b_id, v_seq;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$function$;
