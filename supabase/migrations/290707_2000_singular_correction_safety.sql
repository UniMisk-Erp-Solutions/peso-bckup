-- Singular Expense Correction — Data Safety Migration
--
-- Delivers:
--   1. expense_form_field_value_history — append-only audit table
--   2. fn_archive_expense_form_field_value + trigger — safety net for legacy writes
--   3. Baseline snapshot (idempotent INSERT)
--   4. apply_singular_expense_correction RPC — atomic base + custom-field patch
--
-- DO NOT apply automatically. Run manually in the Supabase SQL editor
-- for project avrbgpmzabktqwyzqibq after verifying in a staging environment.
-- See Documentations MD/singular-correction-custom-field-data-safety.md (DOC-046).

-- ============================================================
-- 1. Append-only history table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.expense_form_field_value_history (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id                UUID        NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  organization_id           UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  template_id               UUID        REFERENCES public.expense_form_field_templates(id) ON DELETE SET NULL,
  branch_field_id           UUID        REFERENCES public.expense_form_field_option_branches(id) ON DELETE SET NULL,
  old_value                 TEXT,
  new_value                 TEXT,
  operation                 TEXT        NOT NULL CHECK (operation IN ('set', 'clear', 'baseline')),
  changed_by                UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  reason                    TEXT,
  expense_correction_log_id UUID        REFERENCES public.expense_correction_logs(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.expense_form_field_value_history IS
  'Append-only audit trail for custom form-field value changes. Written by '
  'apply_singular_expense_correction and the safety-net trigger. Never delete rows.';

CREATE INDEX IF NOT EXISTS idx_efv_history_expense
  ON public.expense_form_field_value_history (expense_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_efv_history_org
  ON public.expense_form_field_value_history (organization_id);

ALTER TABLE public.expense_form_field_value_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read history for viewable expenses"
  ON public.expense_form_field_value_history;

CREATE POLICY "Read history for viewable expenses"
  ON public.expense_form_field_value_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.id = expense_form_field_value_history.expense_id
        AND (
          ex.user_id = auth.uid()
          OR ex.assigned_engineer_id = auth.uid()
          OR ex.assigned_reviewer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.organization_memberships om
            WHERE om.user_id         = auth.uid()
              AND om.organization_id = ex.organization_id
              AND om.role            IN ('admin', 'manager', 'executive', 'team_leader')
              AND om.is_active       = TRUE
          )
        )
    )
  );

-- No INSERT/UPDATE/DELETE for authenticated users; all writes go through the
-- SECURITY DEFINER RPC or the trigger below.

-- ============================================================
-- 2. Safety-net trigger: archives every UPDATE or DELETE on
--    expense_form_field_values so legacy code paths (including
--    replace_expense_form_field_values_by_reviewer) are covered.
--
--    apply_singular_expense_correction sets the session variable
--    app.skip_archive_trigger = 'true' before its own DML and
--    writes to the history table explicitly — preventing double-archive.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_archive_expense_form_field_value()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The new atomic RPC handles archiving itself; skip when inside it.
  IF current_setting('app.skip_archive_trigger', TRUE) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE'
  OR (TG_OP = 'UPDATE' AND OLD.field_value IS DISTINCT FROM NEW.field_value)
  THEN
    INSERT INTO public.expense_form_field_value_history (
      expense_id, organization_id, template_id, branch_field_id,
      old_value, new_value, operation, changed_by
    ) VALUES (
      OLD.expense_id,
      OLD.organization_id,
      OLD.template_id,
      OLD.branch_field_id,
      OLD.field_value,
      CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.field_value END,
      CASE WHEN TG_OP = 'DELETE' THEN 'clear' ELSE 'set' END,
      auth.uid()
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_efv_archive_changes ON public.expense_form_field_values;

CREATE TRIGGER trg_efv_archive_changes
  AFTER UPDATE OR DELETE ON public.expense_form_field_values
  FOR EACH ROW EXECUTE FUNCTION public.fn_archive_expense_form_field_value();

-- ============================================================
-- 3. Baseline snapshot (idempotent)
--    Inserts one 'baseline' history row per live value row that
--    does not already have one. Safe to re-run — the NOT EXISTS
--    guard prevents duplicates.
-- ============================================================

INSERT INTO public.expense_form_field_value_history (
  expense_id, organization_id, template_id, branch_field_id,
  old_value, new_value, operation, changed_by, reason
)
SELECT
  v.expense_id,
  v.organization_id,
  v.template_id,
  v.branch_field_id,
  NULL,
  v.field_value,
  'baseline',
  NULL,
  'Migration baseline: 290707_2000_singular_correction_safety'
FROM public.expense_form_field_values v
WHERE NOT EXISTS (
  SELECT 1
  FROM public.expense_form_field_value_history h
  WHERE h.expense_id      = v.expense_id
    AND h.operation       = 'baseline'
    AND h.template_id     IS NOT DISTINCT FROM v.template_id
    AND h.branch_field_id IS NOT DISTINCT FROM v.branch_field_id
);

-- ============================================================
-- 4. Atomic RPC: apply_singular_expense_correction
--
-- Replaces the non-atomic two-call pattern of:
--   apply_expense_correction (base fields)
--   + replace_expense_form_field_values_by_reviewer (custom fields)
--
-- Everything happens in a single PL/pgSQL transaction:
--   a. Feature-flag check
--   b. Row lock on the expense
--   c. Authorization (admin | assigned engineer/reviewer | manager/executive/team_leader)
--   d. Base field validation and UPDATE
--   e. Correction log INSERT (if base fields changed)
--   f. Per-item patch apply with explicit archive (trigger suppressed)
--
-- p_patch is a JSONB array of PatchItem:
--   { template_id, branch_field_id, operation: "set"|"clear", old_value, new_value }
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_singular_expense_correction(
  p_expense_id      UUID,
  p_organization_id UUID,
  p_updates         JSONB,
  p_reason          TEXT,
  p_patch           JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID    := auth.uid();
  e                public.expenses%ROWTYPE;
  v_feature        BOOLEAN := FALSE;
  v_authorized     BOOLEAN := FALSE;
  v_before         JSONB;
  v_after          JSONB;
  v_log_id         UUID;
  v_item           JSONB;
  v_template_id    UUID;
  v_branch_id      UUID;
  v_op             TEXT;
  v_old_val        TEXT;
  v_new_val        TEXT;
  v_patch_count    INT     := 0;
  v_title          TEXT;
  v_destination    TEXT;
  v_trip_start     DATE;
  v_trip_end       DATE;
  v_purpose        TEXT;
  v_category       TEXT;
  v_total          NUMERIC;
  v_admin_comment  TEXT;
  v_has_base       BOOLEAN := FALSE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Require at least one of p_updates (non-empty) or p_patch (non-empty array)
  IF (p_updates IS NULL
        OR jsonb_typeof(p_updates) <> 'object'
        OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_updates) LIMIT 1))
     AND (p_patch IS NULL
        OR jsonb_typeof(p_patch) <> 'array'
        OR jsonb_array_length(p_patch) = 0)
  THEN
    RAISE EXCEPTION 'No changes to apply: both p_updates and p_patch are empty';
  END IF;

  -- Lock the expense row for the duration of this transaction
  SELECT * INTO e
  FROM public.expenses
  WHERE id = p_expense_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found or does not belong to this organization';
  END IF;

  IF e.user_id = v_uid THEN
    RAISE EXCEPTION 'Corrections are only for expenses submitted by another user';
  END IF;

  IF e.status IN ('draft', 'approved', 'paid') THEN
    RAISE EXCEPTION 'This expense cannot be corrected in its current status (%)' , e.status;
  END IF;

  -- Feature flag check (same as apply_expense_correction)
  IF to_regclass('public.organization_features') IS NOT NULL THEN
    SELECT COALESCE(ofe.enabled, FALSE)
    INTO v_feature
    FROM public.organization_features ofe
    WHERE ofe.organization_id = p_organization_id
      AND ofe.feature_key = 'allow_manager_admin_expense_corrections'
    LIMIT 1;
  END IF;

  IF NOT COALESCE(v_feature, FALSE) THEN
    RAISE EXCEPTION 'Manager/admin expense corrections are disabled for this organization';
  END IF;

  -- Authorization: admin OR assigned engineer/reviewer OR hierarchy role
  v_authorized := EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id         = v_uid
      AND om.organization_id = p_organization_id
      AND om.role            = 'admin'
      AND om.is_active       = TRUE
  );

  IF NOT v_authorized THEN
    v_authorized := (e.assigned_engineer_id = v_uid OR e.assigned_reviewer_id = v_uid);
  END IF;

  IF NOT v_authorized THEN
    v_authorized := EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id         = v_uid
        AND om.organization_id = p_organization_id
        AND om.role            IN ('manager', 'executive', 'team_leader')
        AND om.is_active       = TRUE
    );
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized to correct this expense';
  END IF;

  -- Snapshot current base fields before changes
  v_before := jsonb_build_object(
    'title',         e.title,
    'destination',   e.destination,
    'trip_start',    e.trip_start,
    'trip_end',      e.trip_end,
    'purpose',       e.purpose,
    'category',      e.category,
    'total_amount',  e.total_amount,
    'admin_comment', e.admin_comment
  );

  -- Start from current values; apply only keys present in p_updates
  v_title         := e.title;
  v_destination   := e.destination;
  v_trip_start    := e.trip_start;
  v_trip_end      := e.trip_end;
  v_purpose       := e.purpose;
  v_category      := e.category;
  v_total         := e.total_amount;
  v_admin_comment := e.admin_comment;

  IF p_updates IS NOT NULL AND jsonb_typeof(p_updates) = 'object' THEN
    IF p_updates ? 'title' THEN
      v_title := NULLIF(TRIM(p_updates->>'title'), '');
      IF v_title IS NULL THEN RAISE EXCEPTION 'title cannot be empty'; END IF;
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'destination' THEN
      v_destination := NULLIF(TRIM(p_updates->>'destination'), '');
      IF v_destination IS NULL THEN RAISE EXCEPTION 'destination cannot be empty'; END IF;
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'trip_start' THEN
      v_trip_start := (p_updates->>'trip_start')::DATE;
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'trip_end' THEN
      v_trip_end := (p_updates->>'trip_end')::DATE;
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'purpose' THEN
      v_purpose  := NULLIF(p_updates->>'purpose', '');
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'category' THEN
      v_category := NULLIF(TRIM(p_updates->>'category'), '');
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'total_amount' THEN
      v_total := (p_updates->>'total_amount')::NUMERIC;
      IF v_total IS NULL OR v_total <= 0 THEN
        RAISE EXCEPTION 'total_amount must be a positive number';
      END IF;
      v_has_base := TRUE;
    END IF;
    IF p_updates ? 'admin_comment' THEN
      v_admin_comment := p_updates->>'admin_comment';
      v_has_base := TRUE;
    END IF;
  END IF;

  -- Always UPDATE the row (sets status = edited and updated_at)
  UPDATE public.expenses
  SET
    title         = v_title,
    destination   = v_destination,
    trip_start    = v_trip_start,
    trip_end      = v_trip_end,
    purpose       = v_purpose,
    category      = v_category,
    total_amount  = v_total,
    admin_comment = v_admin_comment,
    status        = 'edited'::public.expense_status,
    updated_at    = now()
  WHERE id = p_expense_id AND organization_id = p_organization_id;

  -- Write correction log when base fields were changed
  IF v_has_base THEN
    SELECT jsonb_build_object(
      'title',         title,
      'destination',   destination,
      'trip_start',    trip_start,
      'trip_end',      trip_end,
      'purpose',       purpose,
      'category',      category,
      'total_amount',  total_amount,
      'admin_comment', admin_comment,
      'status',        status
    )
    INTO v_after
    FROM public.expenses
    WHERE id = p_expense_id;

    INSERT INTO public.expense_correction_logs (
      expense_id, organization_id, edited_by, reason, before_json, after_json
    ) VALUES (
      p_expense_id, p_organization_id, v_uid,
      NULLIF(TRIM(p_reason), ''),
      v_before, v_after
    )
    RETURNING id INTO v_log_id;
  END IF;

  -- Suppress safety-net trigger; we archive explicitly below (no double-archive)
  PERFORM set_config('app.skip_archive_trigger', 'true', TRUE);

  -- Apply each patch item atomically
  FOR v_item IN
    SELECT * FROM jsonb_array_elements(COALESCE(p_patch, '[]'::JSONB))
  LOOP
    v_template_id := (v_item->>'template_id')::UUID;
    v_branch_id   := (v_item->>'branch_field_id')::UUID;
    v_op          := v_item->>'operation';
    v_old_val     := v_item->>'old_value';
    v_new_val     := v_item->>'new_value';

    IF v_op = 'set' THEN
      IF v_template_id IS NOT NULL THEN
        INSERT INTO public.expense_form_field_values
          (expense_id, organization_id, template_id, branch_field_id, field_value)
        VALUES
          (p_expense_id, p_organization_id, v_template_id, NULL, v_new_val)
        ON CONFLICT ON CONSTRAINT uq_form_field_values_expense_template
          DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = now();
      ELSIF v_branch_id IS NOT NULL THEN
        INSERT INTO public.expense_form_field_values
          (expense_id, organization_id, template_id, branch_field_id, field_value)
        VALUES
          (p_expense_id, p_organization_id, NULL, v_branch_id, v_new_val)
        ON CONFLICT ON CONSTRAINT uq_form_field_values_expense_branch
          DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = now();
      END IF;

    ELSIF v_op = 'clear' THEN
      DELETE FROM public.expense_form_field_values
      WHERE expense_id      = p_expense_id
        AND organization_id = p_organization_id
        AND template_id     IS NOT DISTINCT FROM v_template_id
        AND branch_field_id IS NOT DISTINCT FROM v_branch_id;
    END IF;

    -- Explicit archive entry for this patch item
    INSERT INTO public.expense_form_field_value_history (
      expense_id, organization_id, template_id, branch_field_id,
      old_value, new_value, operation, changed_by, reason, expense_correction_log_id
    ) VALUES (
      p_expense_id, p_organization_id, v_template_id, v_branch_id,
      v_old_val, v_new_val, v_op,
      v_uid, p_reason, v_log_id
    );

    v_patch_count := v_patch_count + 1;
  END LOOP;

  -- Re-enable the safety-net trigger for subsequent writes
  PERFORM set_config('app.skip_archive_trigger', 'false', TRUE);

  RETURN jsonb_build_object(
    'ok',                  TRUE,
    'expense_id',          p_expense_id,
    'log_id',              v_log_id,
    'base_fields_changed', v_has_base,
    'patch_items_applied', v_patch_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_singular_expense_correction(UUID, UUID, JSONB, TEXT, JSONB)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.apply_singular_expense_correction(UUID, UUID, JSONB, TEXT, JSONB)
  TO authenticated;

COMMENT ON FUNCTION public.apply_singular_expense_correction(UUID, UUID, JSONB, TEXT, JSONB) IS
  'Atomically corrects base fields and custom field values for a single expense in one '
  'transaction. Uses explicit patch semantics (missing field = no change, never bulk-deletes). '
  'Requires org feature allow_manager_admin_expense_corrections. '
  'Authorization: admin, assigned engineer/reviewer, or hierarchy role '
  '(manager/executive/team_leader). Replaces the non-atomic '
  'apply_expense_correction + replace_expense_form_field_values_by_reviewer pattern.';

NOTIFY pgrst, 'reload schema';
