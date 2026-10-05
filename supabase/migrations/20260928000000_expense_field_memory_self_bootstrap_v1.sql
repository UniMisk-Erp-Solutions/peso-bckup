-- Expense Field Memory: safe, one-time SELF bootstrap (owner QA fix pass,
-- 2026-09-23).
--
-- WHY THIS EXISTS
-- Enabling expense_field_memory for an organization with real history (e.g.
-- "Mistry And Shah", 1,321 approved expenses) currently shows nothing at all
-- until each employee happens to save a brand-new expense -- because
-- get_recent_expense_field_values_v1 only ever reads rows that
-- record_recent_expense_field_values_v1 (a per-save recorder) or the
-- existing admin-only bootstrap_expense_field_memory_v1 have written, and
-- nobody runs the admin bootstrap by default. That is a poor first
-- impression for an enabled feature, not a bug in the read path itself.
--
-- DESIGN
-- A new, self-scoped RPC derives auth.uid() itself (never accepts an
-- arbitrary user_id) and seeds ONLY that employee's own eligible values from
-- their own approved historical expenses -- same eligible-field rules as the
-- existing admin bootstrap (title/destination/purpose + custom/branch
-- text/textarea). A new state table records whether a given (org, user) has
-- ever been bootstrapped, INCLUDING the "genuinely nothing to seed" case, so
-- the client can call this once per employee without re-scanning their
-- entire history on every page load. This is convenience-index population
-- only: it writes exclusively to expense_field_recent_values and this new
-- state table, never to expenses/profiles/balance_ledger/approvals.

CREATE TABLE IF NOT EXISTS public.expense_field_memory_user_state (
  organization_id           uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  bootstrapped_at           timestamptz,
  last_bootstrap_source_at  timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

COMMENT ON TABLE public.expense_field_memory_user_state IS
  'Tracks whether bootstrap_my_expense_field_memory_v1 has already run for a given (organization, user) -- including the case where the employee genuinely had no eligible historical values -- so the client can call it once per employee without repeatedly rescanning their full expense history.';

ALTER TABLE public.expense_field_memory_user_state ENABLE ROW LEVEL SECURITY;

-- Direct client access is read-only and strictly self-scoped, matching
-- expense_field_recent_values's own posture -- all writes go through the
-- SECURITY DEFINER RPC below, never a direct table INSERT/UPDATE.
DROP POLICY IF EXISTS "Users can view their own bootstrap state" ON public.expense_field_memory_user_state;
CREATE POLICY "Users can view their own bootstrap state"
  ON public.expense_field_memory_user_state FOR SELECT
  USING (user_id = auth.uid());

REVOKE ALL ON public.expense_field_memory_user_state FROM PUBLIC;
REVOKE ALL ON public.expense_field_memory_user_state FROM anon;
GRANT SELECT ON public.expense_field_memory_user_state TO authenticated;

CREATE OR REPLACE FUNCTION public.bootstrap_my_expense_field_memory_v1(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_already   boolean;
  v_enabled   boolean;
  v_upserted  integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING errcode = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING errcode = '22023';
  END IF;

  -- Self-scoped only: the caller must be an active member of THIS
  -- organization. There is no user_id parameter to spoof -- every value
  -- derives from auth.uid(), the same posture as record_recent_expense_field_values_v1.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization' USING errcode = '42501';
  END IF;

  SELECT COALESCE(f.enabled, false) INTO v_enabled
  FROM public.organization_features f
  WHERE f.organization_id = p_organization_id AND f.feature_key = 'expense_field_memory';

  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'feature_disabled', 'already_bootstrapped', false, 'upserted', 0);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.expense_field_memory_user_state s
    WHERE s.organization_id = p_organization_id AND s.user_id = v_uid AND s.bootstrapped_at IS NOT NULL
  ) INTO v_already;

  IF v_already THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already_bootstrapped', 'already_bootstrapped', true, 'upserted', 0);
  END IF;

  -- Same eligible-field rules as bootstrap_expense_field_memory_v1 (the
  -- existing admin, org-wide bootstrap) -- approved expenses only, scoped
  -- here to the caller's own expenses.
  WITH src AS (
    SELECT v_uid AS user_id, 'system:title' AS field_identity, 'system' AS field_kind, 'Title' AS field_label,
           e.title AS raw_value, e.created_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id AND e.user_id = v_uid AND e.status = 'approved'
      AND e.title IS NOT NULL AND length(btrim(e.title)) > 0
    UNION ALL
    SELECT v_uid, 'system:destination', 'system', 'Vendor / Location',
           e.destination, e.created_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id AND e.user_id = v_uid AND e.status = 'approved'
      AND e.destination IS NOT NULL AND length(btrim(e.destination)) > 0
    UNION ALL
    SELECT v_uid, 'system:purpose', 'system', 'Purpose',
           e.purpose, e.created_at
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id AND e.user_id = v_uid AND e.status = 'approved'
      AND e.purpose IS NOT NULL AND length(btrim(e.purpose)) > 0
    UNION ALL
    SELECT v_uid, 'custom:' || t.id::text, 'custom', t.name,
           efv.field_value, e.created_at
    FROM public.expenses e
    JOIN public.expense_form_field_values efv ON efv.expense_id = e.id
    JOIN public.expense_form_field_templates t ON t.id = efv.template_id
    WHERE e.organization_id = p_organization_id AND e.user_id = v_uid AND e.status = 'approved'
      AND t.field_type IN ('text', 'textarea')
      AND efv.field_value IS NOT NULL AND length(btrim(efv.field_value)) > 0
    UNION ALL
    SELECT v_uid, 'branch:' || b.id::text, 'branch', b.name,
           efv.field_value, e.created_at
    FROM public.expenses e
    JOIN public.expense_form_field_values efv ON efv.expense_id = e.id
    JOIN public.expense_form_field_option_branches b ON b.id = efv.branch_field_id
    WHERE e.organization_id = p_organization_id AND e.user_id = v_uid AND e.status = 'approved'
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

  -- Marked complete even when v_upserted = 0 -- a genuinely empty eligible
  -- history must not be rescanned on every future page load.
  INSERT INTO public.expense_field_memory_user_state (organization_id, user_id, bootstrapped_at, last_bootstrap_source_at)
  VALUES (p_organization_id, v_uid, now(), now())
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    bootstrapped_at = now(),
    last_bootstrap_source_at = now(),
    updated_at = now();

  RETURN jsonb_build_object('ok', true, 'skipped', NULL, 'already_bootstrapped', false, 'upserted', v_upserted);
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_my_expense_field_memory_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_my_expense_field_memory_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_my_expense_field_memory_v1(uuid) TO authenticated;

DO $verify$
BEGIN
  IF to_regclass('public.expense_field_memory_user_state') IS NULL THEN
    RAISE EXCEPTION 'expense_field_memory_user_state table missing';
  END IF;
  IF to_regprocedure('public.bootstrap_my_expense_field_memory_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'bootstrap_my_expense_field_memory_v1 missing';
  END IF;
  IF has_table_privilege('anon', 'public.expense_field_memory_user_state', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not have access to expense_field_memory_user_state';
  END IF;
  IF has_function_privilege('anon', 'public.bootstrap_my_expense_field_memory_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on bootstrap_my_expense_field_memory_v1';
  END IF;
  RAISE NOTICE 'expense_field_memory_self_bootstrap_v1 migration verified OK';
END;
$verify$;
