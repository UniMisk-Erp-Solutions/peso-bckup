-- Fix custom expense form-field writes.
--
-- Root problems addressed:
--   1) 42P10 "no unique or exclusion constraint matching the ON CONFLICT
--      specification": only PARTIAL unique indexes existed
--      (... WHERE template_id IS NOT NULL). PostgREST upsert with
--      on_conflict="expense_id,template_id" cannot use a partial index unless
--      the client also sends the predicate (it does not). We add NORMAL unique
--      constraints that satisfy the conflict target.
--   2) 57014 statement timeout on the client delete+insert fallback: per-row
--      RLS evaluation across many overlapping permissive policies (each
--      INSERT ... RETURNING re-checks every SELECT policy). We add one
--      SECURITY DEFINER RPC that performs an authorized, atomic replace in a
--      single transaction, bypassing per-row policy overhead.
--
-- Safety:
--   * Duplicates are copied to a backup table BEFORE deletion (deterministic).
--   * No RLS is disabled; no USING(true)/WITH CHECK(true) is introduced.
--   * The RPC performs explicit ownership + organization authorization.
--   * Idempotent: safe to run once even if 20260514120000 / 20260630120000 ran.

-- ===========================================================================
-- 0) Backup table for any rows removed by de-duplication / invalid cleanup
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.expense_form_field_values_dedupe_backup (
  backup_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  removed_at     timestamptz NOT NULL DEFAULT now(),
  removed_reason text NOT NULL,
  migration_tag  text NOT NULL DEFAULT '20260701120000',
  id             uuid,
  organization_id uuid,
  expense_id     uuid,
  template_id    uuid,
  branch_field_id uuid,
  field_value    text,
  created_at     timestamptz,
  updated_at     timestamptz
);

COMMENT ON TABLE public.expense_form_field_values_dedupe_backup IS
  'Audit copy of expense_form_field_values rows removed during dedupe/cleanup. Every removed row is recorded with a reason so duplicates can be reconstructed.';

-- ===========================================================================
-- 1) De-duplicate REGULAR (template) rows, keeping the best row per
--    (expense_id, template_id). "Best" = non-empty value first, then most
--    recently updated, then most recently created, then highest id.
-- ===========================================================================
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY expense_id, template_id
      ORDER BY
        (field_value IS NOT NULL AND btrim(field_value) <> '') DESC,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST,
        id DESC
    ) AS rn
  FROM public.expense_form_field_values
  WHERE template_id IS NOT NULL
),
losers AS (
  SELECT id FROM ranked WHERE rn > 1
)
INSERT INTO public.expense_form_field_values_dedupe_backup (
  removed_reason, id, organization_id, expense_id, template_id,
  branch_field_id, field_value, created_at, updated_at
)
SELECT
  'duplicate_template_row',
  v.id, v.organization_id, v.expense_id, v.template_id,
  v.branch_field_id, v.field_value, v.created_at, v.updated_at
FROM public.expense_form_field_values v
JOIN losers l ON l.id = v.id;

DELETE FROM public.expense_form_field_values v
USING (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY expense_id, template_id
        ORDER BY
          (field_value IS NOT NULL AND btrim(field_value) <> '') DESC,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          id DESC
      ) AS rn
    FROM public.expense_form_field_values
    WHERE template_id IS NOT NULL
  ) r
  WHERE r.rn > 1
) d
WHERE v.id = d.id;

-- ===========================================================================
-- 2) De-duplicate BRANCH rows, keeping the best per (expense_id, branch_field_id).
-- ===========================================================================
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY expense_id, branch_field_id
      ORDER BY
        (field_value IS NOT NULL AND btrim(field_value) <> '') DESC,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST,
        id DESC
    ) AS rn
  FROM public.expense_form_field_values
  WHERE branch_field_id IS NOT NULL
),
losers AS (
  SELECT id FROM ranked WHERE rn > 1
)
INSERT INTO public.expense_form_field_values_dedupe_backup (
  removed_reason, id, organization_id, expense_id, template_id,
  branch_field_id, field_value, created_at, updated_at
)
SELECT
  'duplicate_branch_row',
  v.id, v.organization_id, v.expense_id, v.template_id,
  v.branch_field_id, v.field_value, v.created_at, v.updated_at
FROM public.expense_form_field_values v
JOIN losers l ON l.id = v.id;

DELETE FROM public.expense_form_field_values v
USING (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY expense_id, branch_field_id
        ORDER BY
          (field_value IS NOT NULL AND btrim(field_value) <> '') DESC,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          id DESC
      ) AS rn
    FROM public.expense_form_field_values
    WHERE branch_field_id IS NOT NULL
  ) r
  WHERE r.rn > 1
) d
WHERE v.id = d.id;

-- ===========================================================================
-- 3) Quarantine invalid rows (both IDs set, or neither). These cannot satisfy
--    the one-source-id check constraint. Back them up, then remove them.
--    Any such rows are reported as historical data that must be re-entered.
-- ===========================================================================
INSERT INTO public.expense_form_field_values_dedupe_backup (
  removed_reason, id, organization_id, expense_id, template_id,
  branch_field_id, field_value, created_at, updated_at
)
SELECT
  'invalid_source_id',
  v.id, v.organization_id, v.expense_id, v.template_id,
  v.branch_field_id, v.field_value, v.created_at, v.updated_at
FROM public.expense_form_field_values v
WHERE (v.template_id IS NULL AND v.branch_field_id IS NULL)
   OR (v.template_id IS NOT NULL AND v.branch_field_id IS NOT NULL);

DELETE FROM public.expense_form_field_values v
WHERE (v.template_id IS NULL AND v.branch_field_id IS NULL)
   OR (v.template_id IS NOT NULL AND v.branch_field_id IS NOT NULL);

-- ===========================================================================
-- 4) Replace partial unique indexes with NORMAL unique constraints.
--    NULLs are distinct in a unique constraint, so template rows
--    (branch_field_id NULL) and branch rows (template_id NULL) coexist.
-- ===========================================================================
DROP INDEX IF EXISTS public.idx_form_field_values_expense_template;
DROP INDEX IF EXISTS public.idx_form_field_values_expense_branch;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_form_field_values'::regclass
      AND conname = 'uq_form_field_values_expense_template'
  ) THEN
    ALTER TABLE public.expense_form_field_values
      ADD CONSTRAINT uq_form_field_values_expense_template
      UNIQUE (expense_id, template_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_form_field_values'::regclass
      AND conname = 'uq_form_field_values_expense_branch'
  ) THEN
    ALTER TABLE public.expense_form_field_values
      ADD CONSTRAINT uq_form_field_values_expense_branch
      UNIQUE (expense_id, branch_field_id);
  END IF;
END $$;

-- ===========================================================================
-- 5) Ensure the one-source-id CHECK constraint exists.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expense_form_field_values'::regclass
      AND conname = 'expense_form_field_values_template_or_branch'
  ) THEN
    ALTER TABLE public.expense_form_field_values
      ADD CONSTRAINT expense_form_field_values_template_or_branch CHECK (
        (template_id IS NOT NULL AND branch_field_id IS NULL)
        OR (template_id IS NULL AND branch_field_id IS NOT NULL)
      );
  END IF;
END $$;

-- ===========================================================================
-- 6) Indexes for fast writes + RLS predicate lookups.
--    The unique constraints above already create indexes leading with
--    expense_id, so a separate (expense_id) index is redundant — but the base
--    migration's idx_form_field_values_expense may already exist; leave it.
--    Add the composite used by reads/writes that filter by org + expense.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS idx_form_field_values_org_expense
  ON public.expense_form_field_values (organization_id, expense_id);

-- RLS predicates on expenses / organization_memberships reference these.
CREATE INDEX IF NOT EXISTS idx_expenses_organization_id
  ON public.expenses (organization_id);
CREATE INDEX IF NOT EXISTS idx_expenses_user_id
  ON public.expenses (user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_org
  ON public.organization_memberships (user_id, organization_id);

-- ===========================================================================
-- 7) Atomic, authorized replace RPC.
--    p_values: jsonb array of
--      { "template_id": uuid|null, "branch_field_id": uuid|null, "field_value": text }
-- ===========================================================================
DROP FUNCTION IF EXISTS public.replace_expense_form_field_values(uuid, uuid, jsonb);

CREATE FUNCTION public.replace_expense_form_field_values(
  p_expense_id uuid,
  p_organization_id uuid,
  p_values jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e public.expenses%ROWTYPE;
  v_org uuid;
  v_is_owner_editable boolean := false;
  v_is_admin boolean := false;
  v_category_id uuid;
  v_saved_count integer := 0;
  v_row_count integer := 0;
  v_norm jsonb;
BEGIN
  -- 7.1 Authenticated user required.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING errcode = '28000';
  END IF;

  -- 7.2 Lock the parent expense and verify it exists.
  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING errcode = 'P0002';
  END IF;

  v_org := e.organization_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Expense has no organization' USING errcode = '22023';
  END IF;

  -- 7.3 Never trust the client org alone: it must match the server-side row.
  IF p_organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'organization_id does not match expense' USING errcode = '42501';
  END IF;

  -- 7.4 Authorization: owner editing an editable status, or an org admin.
  --     Mirrors canOwnerEditExpenseStatus() in the app (draft/submitted/rejected).
  v_is_owner_editable :=
    (e.user_id = v_uid
     AND e.status::text IN ('draft', 'submitted', 'rejected'));

  v_is_admin := EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_org
      AND om.role = 'admin'
      AND om.is_active = true
  );

  IF NOT v_is_owner_editable AND NOT v_is_admin THEN
    RAISE EXCEPTION 'Not authorized to edit custom fields for this expense'
      USING errcode = '42501';
  END IF;

  -- 7.5 Validate payload shape.
  IF p_values IS NULL THEN
    p_values := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(p_values) <> 'array' THEN
    RAISE EXCEPTION 'p_values must be a JSON array' USING errcode = '22023';
  END IF;

  -- Normalize into a working set, keeping only genuinely filled values.
  -- NOTE: "0" and "false" are valid values and are preserved; only JSON null
  -- and the empty string are treated as "not provided".
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'template_id', NULLIF(elem->>'template_id', ''),
        'branch_field_id', NULLIF(elem->>'branch_field_id', ''),
        'field_value', elem->>'field_value'
      )
    ),
    '[]'::jsonb
  )
  INTO v_norm
  FROM jsonb_array_elements(p_values) AS elem
  WHERE (elem->>'field_value') IS NOT NULL
    AND (elem->>'field_value') <> '';

  -- 7.6 Exactly one source id per row.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(v_norm)
      AS x(template_id uuid, branch_field_id uuid, field_value text)
    WHERE (x.template_id IS NULL AND x.branch_field_id IS NULL)
       OR (x.template_id IS NOT NULL AND x.branch_field_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'each value must set exactly one of template_id or branch_field_id'
      USING errcode = '22023';
  END IF;

  -- 7.7 No duplicate template ids in the payload.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(v_norm)
      AS x(template_id uuid, branch_field_id uuid, field_value text)
    WHERE x.template_id IS NOT NULL
    GROUP BY x.template_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate template_id in payload' USING errcode = '22023';
  END IF;

  -- 7.8 No duplicate branch ids in the payload.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(v_norm)
      AS x(template_id uuid, branch_field_id uuid, field_value text)
    WHERE x.branch_field_id IS NOT NULL
    GROUP BY x.branch_field_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate branch_field_id in payload' USING errcode = '22023';
  END IF;

  -- 7.9 Every template_id must belong to this organization (cross-org guard).
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(v_norm)
      AS i(template_id uuid, branch_field_id uuid, field_value text)
    WHERE i.template_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.expense_form_field_templates t
        WHERE t.id = i.template_id
          AND t.organization_id = v_org
      )
  ) THEN
    RAISE EXCEPTION 'template_id does not belong to this organization'
      USING errcode = '42501';
  END IF;

  -- 7.10 Every branch_field_id must belong to this organization (cross-org guard).
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(v_norm)
      AS i(template_id uuid, branch_field_id uuid, field_value text)
    WHERE i.branch_field_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.expense_form_field_option_branches b
        WHERE b.id = i.branch_field_id
          AND b.organization_id = v_org
      )
  ) THEN
    RAISE EXCEPTION 'branch_field_id does not belong to this organization'
      USING errcode = '42501';
  END IF;

  -- 7.11 Soft category validation: when the expense category resolves to a
  --      category row, every provided template must be assigned to it. Legacy
  --      enum categories that do not map to expense_categories are skipped so
  --      historical expenses still save.
  SELECT c.id INTO v_category_id
  FROM public.expense_categories c
  WHERE c.organization_id = v_org
    AND lower(c.name) = lower(e.category::text)
  LIMIT 1;

  IF v_category_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(v_norm)
        AS i(template_id uuid, branch_field_id uuid, field_value text)
      WHERE i.template_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.expense_category_form_fields cff
          WHERE cff.template_id = i.template_id
            AND cff.category_id = v_category_id
            AND cff.organization_id = v_org
        )
    ) THEN
      RAISE EXCEPTION 'a template field is not valid for this expense category'
        USING errcode = '22023';
    END IF;
  END IF;

  -- 7.12 Atomic replace: delete all current values for the expense, then insert
  --      the validated set. Any failure rolls back the whole function.
  DELETE FROM public.expense_form_field_values
  WHERE expense_id = p_expense_id;

  INSERT INTO public.expense_form_field_values (
    organization_id, expense_id, template_id, branch_field_id, field_value
  )
  SELECT v_org, p_expense_id, i.template_id, i.branch_field_id, i.field_value
  FROM jsonb_to_recordset(v_norm)
    AS i(template_id uuid, branch_field_id uuid, field_value text);

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_saved_count := v_row_count;

  RETURN jsonb_build_object('saved_count', v_saved_count);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_expense_form_field_values(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_expense_form_field_values(uuid, uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.replace_expense_form_field_values(uuid, uuid, jsonb) IS
  'Atomically replace all custom form-field values for one expense after explicit owner/admin + organization authorization. Single transaction; avoids per-row RLS overhead and partial writes.';

-- ===========================================================================
-- 8) Reload PostgREST schema cache so the new constraints + RPC are visible.
-- ===========================================================================
NOTIFY pgrst, 'reload schema';
