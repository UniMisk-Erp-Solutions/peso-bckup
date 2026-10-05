-- Recently-used free-text expense field values, per organization + per employee.
--
-- Scope: this is deliberately narrower than "all form fields". The repo already
-- has DOC-003 (form_field_option_usage_tracking + increment_form_field_option_usage)
-- which re-ranks an EXISTING static option list for select-type fields (base
-- dropdown fields, custom "select" templates/branches). That system is untouched
-- by this migration. This migration covers the gap DOC-003 does not: free-text
-- fields, where there is no fixed option list to re-rank -- title/destination/
-- purpose (base fields, when not overridden to "dropdown"/"number"), and custom
-- "text"/"textarea" templates + conditional-dropdown branches of the same types.
--
-- Field identity ("field_identity" below) is a namespaced, stable key so an
-- admin renaming a custom field's label (or a base field's display label)
-- never orphans an employee's memory:
--   system:<base_field_key>   -- title | destination | purpose (closed platform enum)
--   custom:<template_uuid>    -- expense_form_field_templates.id
--   branch:<branch_uuid>      -- expense_form_field_option_branches.id
--
-- Feature gate: organization_features.feature_key = 'expense_field_memory'.
-- Absence of a row means disabled (organization_features has no default-enabled
-- semantics anywhere in this codebase); this migration seeds no rows, so every
-- organization -- including Patidar -- stays OFF until explicitly toggled via
-- the existing Master Admin feature-flag UI. No code path here reads/writes
-- expenses.total_amount, profiles.balance, balance_ledger, expense_balance_deductions,
-- or any approval/review state.

CREATE TABLE IF NOT EXISTS public.expense_field_recent_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  field_identity text NOT NULL,
  field_kind text NOT NULL CHECK (field_kind IN ('system', 'custom', 'branch')),
  field_label text NOT NULL,
  display_value text NOT NULL,
  normalized_value text NOT NULL,
  usage_count integer NOT NULL DEFAULT 1,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  last_expense_id uuid REFERENCES public.expenses (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_field_recent_values_normalized_not_blank
    CHECK (length(btrim(normalized_value)) > 0),
  UNIQUE (organization_id, user_id, field_identity, normalized_value)
);

COMMENT ON TABLE public.expense_field_recent_values IS
  'Per-employee, per-organization recently-used free-text expense field values (DOC-130). Additive/convenience only -- never required for expense save, never read by accounting/report code.';

CREATE INDEX IF NOT EXISTS idx_efrv_lookup
  ON public.expense_field_recent_values (organization_id, user_id, field_identity, last_used_at DESC);

ALTER TABLE public.expense_field_recent_values ENABLE ROW LEVEL SECURITY;

-- Direct client access is read-only and strictly self-scoped. All writes go
-- through record_recent_expense_field_values_v1 / bootstrap_expense_field_memory_v1
-- (SECURITY DEFINER), never a direct table INSERT/UPDATE from the client.
DROP POLICY IF EXISTS "Users can view their own recent field values" ON public.expense_field_recent_values;
CREATE POLICY "Users can view their own recent field values"
  ON public.expense_field_recent_values FOR SELECT
  USING (
    user_id = auth.uid()
    AND organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP TRIGGER IF EXISTS update_expense_field_recent_values_updated_at ON public.expense_field_recent_values;
CREATE TRIGGER update_expense_field_recent_values_updated_at
  BEFORE UPDATE ON public.expense_field_recent_values
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

REVOKE ALL ON public.expense_field_recent_values FROM PUBLIC;
GRANT SELECT ON public.expense_field_recent_values TO authenticated;
GRANT ALL ON public.expense_field_recent_values TO service_role;

-- ---------------------------------------------------------------------------
-- READ: batch fetch, up to 25 most-recent unique values per field_identity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_recent_expense_field_values_v1(
  p_organization_id uuid,
  p_field_identities text[] DEFAULT NULL
)
RETURNS TABLE (
  field_identity text,
  display_value text,
  normalized_value text,
  last_used_at timestamptz,
  usage_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_enabled boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING errcode = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization' USING errcode = '42501';
  END IF;

  SELECT COALESCE(f.enabled, false) INTO v_enabled
  FROM public.organization_features f
  WHERE f.organization_id = p_organization_id AND f.feature_key = 'expense_field_memory';

  -- Feature OFF (or no row at all -- absence means disabled): return an empty
  -- set rather than raising, so the frontend's degrade-to-[] path is trivial.
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT r.field_identity, r.display_value, r.normalized_value, r.last_used_at, r.usage_count
  FROM (
    SELECT
      v.field_identity,
      v.display_value,
      v.normalized_value,
      v.last_used_at,
      v.usage_count,
      row_number() OVER (
        PARTITION BY v.field_identity
        ORDER BY v.last_used_at DESC, v.normalized_value ASC
      ) AS rn
    FROM public.expense_field_recent_values v
    WHERE v.organization_id = p_organization_id
      AND v.user_id = v_uid
      AND (p_field_identities IS NULL OR v.field_identity = ANY (p_field_identities))
  ) r
  WHERE r.rn <= 25
  ORDER BY r.field_identity, r.last_used_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_recent_expense_field_values_v1(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_recent_expense_field_values_v1(uuid, text[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- WRITE: derive eligible values from the ALREADY-PERSISTED expense row (never
-- from a client-supplied payload), then upsert (increment). Called as a
-- separate, best-effort statement strictly after the expense save/custom-field
-- save has already committed -- a failure here cannot roll back or block the
-- expense itself, by construction (see src/pages/ExpenseForm.tsx call site).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_recent_expense_field_values_v1(
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_expense record;
  v_enabled boolean;
  v_recorded integer := 0;
  v_row record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING errcode = '28000';
  END IF;

  SELECT e.id, e.organization_id, e.user_id, e.title, e.destination, e.purpose
  INTO v_expense
  FROM public.expenses e
  WHERE e.id = p_expense_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING errcode = '42704';
  END IF;

  -- v1 scope: only the expense's own owner records their own memory (matches
  -- the ExpenseForm.tsx self-service save flow this is wired into). Admin
  -- corrections / MicroLink import / admin-submit-for-employee do not call
  -- this RPC in v1 -- see Documentations MD/expense-field-memory.md "Known
  -- limitations".
  IF v_expense.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not permitted' USING errcode = '42501';
  END IF;

  SELECT COALESCE(f.enabled, false) INTO v_enabled
  FROM public.organization_features f
  WHERE f.organization_id = v_expense.organization_id AND f.feature_key = 'expense_field_memory';

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('ok', true, 'recorded', 0, 'reason', 'feature_disabled');
  END IF;

  -- Base free-text fields: title / destination / purpose only (category is a
  -- managed dropdown, expense_date is a date, amount is currency -- excluded
  -- by design, not by this organization's configuration).
  IF v_expense.title IS NOT NULL AND length(btrim(v_expense.title)) > 0 THEN
    INSERT INTO public.expense_field_recent_values (
      organization_id, user_id, field_identity, field_kind, field_label,
      display_value, normalized_value, usage_count, last_used_at, last_expense_id
    ) VALUES (
      v_expense.organization_id, v_uid, 'system:title', 'system', 'Title',
      btrim(v_expense.title), lower(regexp_replace(btrim(v_expense.title), '\s+', ' ', 'g')),
      1, now(), p_expense_id
    )
    ON CONFLICT (organization_id, user_id, field_identity, normalized_value) DO UPDATE SET
      display_value = EXCLUDED.display_value,
      usage_count = public.expense_field_recent_values.usage_count + 1,
      last_used_at = now(),
      last_expense_id = p_expense_id,
      updated_at = now();
    v_recorded := v_recorded + 1;
  END IF;

  IF v_expense.destination IS NOT NULL AND length(btrim(v_expense.destination)) > 0 THEN
    INSERT INTO public.expense_field_recent_values (
      organization_id, user_id, field_identity, field_kind, field_label,
      display_value, normalized_value, usage_count, last_used_at, last_expense_id
    ) VALUES (
      v_expense.organization_id, v_uid, 'system:destination', 'system', 'Vendor / Location',
      btrim(v_expense.destination), lower(regexp_replace(btrim(v_expense.destination), '\s+', ' ', 'g')),
      1, now(), p_expense_id
    )
    ON CONFLICT (organization_id, user_id, field_identity, normalized_value) DO UPDATE SET
      display_value = EXCLUDED.display_value,
      usage_count = public.expense_field_recent_values.usage_count + 1,
      last_used_at = now(),
      last_expense_id = p_expense_id,
      updated_at = now();
    v_recorded := v_recorded + 1;
  END IF;

  IF v_expense.purpose IS NOT NULL AND length(btrim(v_expense.purpose)) > 0 THEN
    INSERT INTO public.expense_field_recent_values (
      organization_id, user_id, field_identity, field_kind, field_label,
      display_value, normalized_value, usage_count, last_used_at, last_expense_id
    ) VALUES (
      v_expense.organization_id, v_uid, 'system:purpose', 'system', 'Purpose',
      btrim(v_expense.purpose), lower(regexp_replace(btrim(v_expense.purpose), '\s+', ' ', 'g')),
      1, now(), p_expense_id
    )
    ON CONFLICT (organization_id, user_id, field_identity, normalized_value) DO UPDATE SET
      display_value = EXCLUDED.display_value,
      usage_count = public.expense_field_recent_values.usage_count + 1,
      last_used_at = now(),
      last_expense_id = p_expense_id,
      updated_at = now();
    v_recorded := v_recorded + 1;
  END IF;

  -- Custom template fields of type text/textarea (select is DOC-003's turf).
  FOR v_row IN
    SELECT efv.field_value, t.id AS template_id, t.name AS template_name
    FROM public.expense_form_field_values efv
    JOIN public.expense_form_field_templates t ON t.id = efv.template_id
    WHERE efv.expense_id = p_expense_id
      AND efv.template_id IS NOT NULL
      AND t.field_type IN ('text', 'textarea')
      AND efv.field_value IS NOT NULL
      AND length(btrim(efv.field_value)) > 0
  LOOP
    INSERT INTO public.expense_field_recent_values (
      organization_id, user_id, field_identity, field_kind, field_label,
      display_value, normalized_value, usage_count, last_used_at, last_expense_id
    ) VALUES (
      v_expense.organization_id, v_uid, 'custom:' || v_row.template_id::text, 'custom', v_row.template_name,
      btrim(v_row.field_value), lower(regexp_replace(btrim(v_row.field_value), '\s+', ' ', 'g')),
      1, now(), p_expense_id
    )
    ON CONFLICT (organization_id, user_id, field_identity, normalized_value) DO UPDATE SET
      display_value = EXCLUDED.display_value,
      usage_count = public.expense_field_recent_values.usage_count + 1,
      last_used_at = now(),
      last_expense_id = p_expense_id,
      updated_at = now();
    v_recorded := v_recorded + 1;
  END LOOP;

  -- Dependent/conditional branch fields of type text/textarea.
  FOR v_row IN
    SELECT efv.field_value, b.id AS branch_id, b.name AS branch_name
    FROM public.expense_form_field_values efv
    JOIN public.expense_form_field_option_branches b ON b.id = efv.branch_field_id
    WHERE efv.expense_id = p_expense_id
      AND efv.branch_field_id IS NOT NULL
      AND b.field_type IN ('text', 'textarea')
      AND efv.field_value IS NOT NULL
      AND length(btrim(efv.field_value)) > 0
  LOOP
    INSERT INTO public.expense_field_recent_values (
      organization_id, user_id, field_identity, field_kind, field_label,
      display_value, normalized_value, usage_count, last_used_at, last_expense_id
    ) VALUES (
      v_expense.organization_id, v_uid, 'branch:' || v_row.branch_id::text, 'branch', v_row.branch_name,
      btrim(v_row.field_value), lower(regexp_replace(btrim(v_row.field_value), '\s+', ' ', 'g')),
      1, now(), p_expense_id
    )
    ON CONFLICT (organization_id, user_id, field_identity, normalized_value) DO UPDATE SET
      display_value = EXCLUDED.display_value,
      usage_count = public.expense_field_recent_values.usage_count + 1,
      last_used_at = now(),
      last_expense_id = p_expense_id,
      updated_at = now();
    v_recorded := v_recorded + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'recorded', v_recorded);
END;
$$;

REVOKE ALL ON FUNCTION public.record_recent_expense_field_values_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_recent_expense_field_values_v1(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- BOOTSTRAP: idempotent historical seed for ONE organization, admin-triggered.
-- Uses SET (absolute recompute) semantics, not increment -- running this twice
-- converges to the same state rather than doubling usage_count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bootstrap_expense_field_memory_v1(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_upserted integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING errcode = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id
      AND om.is_active = true AND om.role = 'admin'::app_role
  ) THEN
    RAISE EXCEPTION 'Admin role required in this organization' USING errcode = '42501';
  END IF;

  WITH src AS (
    SELECT e.user_id, 'system:title' AS field_identity, 'system' AS field_kind, 'Title' AS field_label,
           e.title AS raw_value, e.created_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id AND e.status = 'approved'
      AND e.title IS NOT NULL AND length(btrim(e.title)) > 0
    UNION ALL
    SELECT e.user_id, 'system:destination', 'system', 'Vendor / Location',
           e.destination, e.created_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id AND e.status = 'approved'
      AND e.destination IS NOT NULL AND length(btrim(e.destination)) > 0
    UNION ALL
    SELECT e.user_id, 'system:purpose', 'system', 'Purpose',
           e.purpose, e.created_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id AND e.status = 'approved'
      AND e.purpose IS NOT NULL AND length(btrim(e.purpose)) > 0
    UNION ALL
    SELECT e.user_id, 'custom:' || t.id::text, 'custom', t.name,
           efv.field_value, e.created_at
    FROM public.expenses e
    JOIN public.expense_form_field_values efv ON efv.expense_id = e.id
    JOIN public.expense_form_field_templates t ON t.id = efv.template_id
    WHERE e.organization_id = p_organization_id AND e.status = 'approved'
      AND t.field_type IN ('text', 'textarea')
      AND efv.field_value IS NOT NULL AND length(btrim(efv.field_value)) > 0
    UNION ALL
    SELECT e.user_id, 'branch:' || b.id::text, 'branch', b.name,
           efv.field_value, e.created_at
    FROM public.expenses e
    JOIN public.expense_form_field_values efv ON efv.expense_id = e.id
    JOIN public.expense_form_field_option_branches b ON b.id = efv.branch_field_id
    WHERE e.organization_id = p_organization_id AND e.status = 'approved'
      AND b.field_type IN ('text', 'textarea')
      AND efv.field_value IS NOT NULL AND length(btrim(efv.field_value)) > 0
  ),
  normalized AS (
    SELECT user_id, field_identity, field_kind, field_label, raw_value,
           lower(regexp_replace(btrim(raw_value), '\s+', ' ', 'g')) AS normalized_value,
           created_at
    FROM src
  ),
  aggregated AS (
    SELECT
      user_id, field_identity, field_kind, field_label, normalized_value,
      (array_agg(raw_value ORDER BY created_at DESC))[1] AS display_value,
      min(created_at) AS first_used_at,
      max(created_at) AS last_used_at,
      count(*)::integer AS usage_count
    FROM normalized
    GROUP BY user_id, field_identity, field_kind, field_label, normalized_value
  ),
  upserted AS (
    INSERT INTO public.expense_field_recent_values (
      organization_id, user_id, field_identity, field_kind, field_label,
      display_value, normalized_value, usage_count, first_used_at, last_used_at
    )
    SELECT
      p_organization_id, a.user_id, a.field_identity, a.field_kind, a.field_label,
      a.display_value, a.normalized_value, a.usage_count, a.first_used_at, a.last_used_at
    FROM aggregated a
    ON CONFLICT (organization_id, user_id, field_identity, normalized_value) DO UPDATE SET
      display_value = EXCLUDED.display_value,
      field_label = EXCLUDED.field_label,
      usage_count = EXCLUDED.usage_count,
      first_used_at = LEAST(public.expense_field_recent_values.first_used_at, EXCLUDED.first_used_at),
      last_used_at = EXCLUDED.last_used_at,
      updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_upserted FROM upserted;

  RETURN jsonb_build_object('ok', true, 'organization_id', p_organization_id, 'upserted', v_upserted);
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_expense_field_memory_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bootstrap_expense_field_memory_v1(uuid) TO authenticated;

DO $verify$
BEGIN
  IF to_regclass('public.expense_field_recent_values') IS NULL THEN
    RAISE EXCEPTION 'expense_field_recent_values table missing';
  END IF;
  IF to_regprocedure('public.get_recent_expense_field_values_v1(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'get_recent_expense_field_values_v1 missing';
  END IF;
  IF to_regprocedure('public.record_recent_expense_field_values_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'record_recent_expense_field_values_v1 missing';
  END IF;
  IF to_regprocedure('public.bootstrap_expense_field_memory_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'bootstrap_expense_field_memory_v1 missing';
  END IF;
  RAISE NOTICE 'expense_field_recent_values_v1 migration verified OK';
END;
$verify$;
