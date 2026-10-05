-- ============================================================================
-- HOTFIX: deploy apply_singular_expense_correction (PGRST202 on Preview)
--
-- INCIDENT: the hotfix/submitted-expense-edit-regression Preview's owner-QA
-- correction flow calls POST /rest/v1/rpc/apply_singular_expense_correction
-- and gets HTTP 404 PGRST202. Live-state audit (read-only, via SSH to
-- websrv / supabase-db-evo3o0fdjaroxq7uohrm21cp) confirmed the entire
-- historical migration supabase/migrations/290707_2000_singular_correction_safety.sql
-- is absent from Production -- not a PostgREST cache issue:
--   apply_singular_expense_correction   MISSING (pg_proc)
--   expense_form_field_value_history    MISSING (pg_class)
--   fn_archive_expense_form_field_value MISSING (pg_proc)
--   trg_efv_archive_changes             MISSING (pg_trigger)
-- The file's own header says "DO NOT apply automatically... run manually
-- after verifying in staging" -- it was authored but never applied.
--
-- WHY NOT A STRAIGHT REPLAY: rehearsing the exact historical file against a
-- throwaway restore of the current Production backup fails immediately:
--
--   ERROR: invalid input value for enum app_role: "manager"
--
-- The current app_role enum is (admin, engineer, employee, cashier,
-- team_leader, executive) -- no 'manager'. The historical migration's RLS
-- policy and RPC authorization block both hard-code
-- role IN ('admin','manager','executive','team_leader'), which predates the
-- CURRENT canonical hierarchy-authorization helper,
-- expense_hierarchy_reviewer_can_act(e, uid) (already live, used by the
-- live apply_expense_correction RPC). Blindly replaying the stale role list
-- would either fail outright (RLS) or -- had 'manager' still been a valid
-- enum value -- silently authorized a role that no longer has any real
-- membership rows, which is not the actual product contract either way.
--
-- FIX: same table/trigger/baseline/RPC as the historical file, byte-for-byte,
-- EXCEPT the authorization logic in the RLS policy and the RPC is replaced
-- with the exact same pattern the LIVE apply_expense_correction RPC already
-- uses: admin, OR the assigned engineer (role='engineer' AND
-- (assigned_engineer_id = uid OR (approval_tier='engineer' AND
-- assigned_reviewer_id = uid))), OR expense_hierarchy_reviewer_can_act(e, uid).
-- This is the verified CURRENT contract, not a reintroduction of a stale one.
--
-- Everything else (attachments, balances, approval, transaction numbers) is
-- untouched by this RPC exactly as in the historical file: it never allocates
-- a transaction number, never inserts a second expenses row, never touches
-- attachments/balance tables, and only ever sets status = 'edited'.
--
-- REQUIRED-FIELD INTEGRITY -- TWO ROUNDS OF CORRECTION, VERIFIED BY REHEARSAL:
--
-- Round 1: the first draft of this migration assumed the already-live
-- DEFERRED constraint trigger protect_required_fields_after_submission
-- (20260907120000) would catch a correction that strips a required custom
-- field, since it fires on every write to expense_form_field_values
-- regardless of which function performs it. Throwaway rehearsal proved that
-- assumption WRONG: that trigger explicitly treats 'edited' as an unguarded/
-- editable status (draft/rejected/edited), and this RPC sets
-- status = 'edited' on every correction -- so the deferred guard silently
-- skips exactly the write this RPC makes. Confirmed by forcing
-- SET CONSTRAINTS ALL IMMEDIATE after a real attempt: a required MicroLink
-- "Project Unique ID" value was actually deleted from a real employee's
-- expense (aed3ae99..., employee 5022, txn 19935) with no error.
--
-- Round 2: fixing that by calling validate_expense_submission_invariants_v1
-- unconditionally was ALSO wrong, proven by rehearsing against the SAME real
-- expense: it predates the current From/To location requirement (legacy
-- data), so full current-policy validation rejected even a title-only
-- correction that had nothing to do with From/To. Corrections must not
-- retroactively force historical records to satisfy requirements that did
-- not exist when they were submitted -- they must only be stopped from
-- making things WORSE.
--
-- FINAL: a baseline-aware no-regression check. Computes the canonical
-- structured diagnostic expense_submission_integrity_issues_v1 (the same
-- function validate_expense_submission_invariants_v1 itself is built on)
-- BEFORE this correction touches anything, and again AFTER. An issue in the
-- after-set is rejected only when it is genuinely NEW (no matching identity
-- in the before-set, keyed by issue_code + issue_source + template_id +
-- branch_field_id + field_key -- never text or counts) OR it concerns a
-- template/branch this correction actually touched (so a legacy defect
-- cannot be mutated into a different, or the same, defect and wave through).
-- Untouched pre-existing debt survives unchanged. Re-rehearsed against the
-- same real legacy expense: title-only correction now PASSES with the
-- historical From/To gap intact; stripping the Project Unique ID still
-- REJECTS.
-- ============================================================================

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

-- HOTFIX CHANGE: role list ('admin','manager','executive','team_leader')
-- replaced with the current canonical hierarchy helper, matching the live
-- apply_expense_correction contract exactly (see header note).
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
              AND om.role            = 'admin'
              AND om.is_active       = TRUE
          )
          OR public.expense_hierarchy_reviewer_can_act(ex, auth.uid())
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
  'Migration baseline: 20260909200000_singular_expense_correction_rpc'
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
--   c. Authorization (admin | assigned engineer | hierarchy reviewer) --
--      HOTFIX CHANGE: matches the live apply_expense_correction contract
--      exactly, via expense_hierarchy_reviewer_can_act(e, uid), instead of
--      the historical file's stale role IN ('manager','executive','team_leader').
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
  -- Baseline-aware no-regression integrity check (hotfix 2026-09-10).
  v_issues_before  JSONB;
  v_issues_after   JSONB;
  v_disallowed     JSONB;
  v_touched_tmpl   UUID[]  := '{}';
  v_touched_branch UUID[]  := '{}';
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

  -- Authorization: admin OR assigned engineer OR hierarchy reviewer --
  -- identical to the live apply_expense_correction contract.
  v_authorized := EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id         = v_uid
      AND om.organization_id = p_organization_id
      AND om.role            = 'admin'
      AND om.is_active       = TRUE
  );

  IF NOT v_authorized THEN
    v_authorized := EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id         = v_uid
        AND om.organization_id = p_organization_id
        AND om.role            = 'engineer'
        AND om.is_active       = TRUE
    ) AND (e.assigned_engineer_id = v_uid
           OR (e.approval_tier = 'engineer' AND e.assigned_reviewer_id = v_uid));
  END IF;

  IF NOT v_authorized THEN
    v_authorized := public.expense_hierarchy_reviewer_can_act(e, v_uid);
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized to correct this expense';
  END IF;

  -- Baseline-aware no-regression check, PART 1: canonical structured issues
  -- BEFORE this correction touches anything. Reuses the same diagnostic the
  -- MicroLink atomic engine and the submission triggers already use -- no
  -- second interpretation of required-field/branch-dependency rules.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'issue_code', issue_code, 'issue_source', issue_source,
           'template_id', template_id, 'branch_field_id', branch_field_id,
           'field_key', field_key)), '[]'::jsonb)
    INTO v_issues_before
  FROM public.expense_submission_integrity_issues_v1(p_expense_id);

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

    -- Baseline-aware no-regression check, PART 2: record what this
    -- correction actually touched. An issue on a touched template/branch is
    -- never grandfathered, even if an issue with the identical code existed
    -- before -- an admin may not mutate a grandfathered legacy defect into a
    -- different (or the same) defect and have it wave through as "no new
    -- issue". A parent template_id also covers its dependent branch issues,
    -- since expense_submission_integrity_issues_v1 keys branch issues by
    -- their PARENT template_id.
    IF v_template_id IS NOT NULL THEN
      v_touched_tmpl := array_append(v_touched_tmpl, v_template_id);
    END IF;
    IF v_branch_id IS NOT NULL THEN
      v_touched_branch := array_append(v_touched_branch, v_branch_id);
    END IF;

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

  -- HARD GATE (hotfix 2026-09-10) -- BASELINE-AWARE NO-REGRESSION CHECK.
  --
  -- trg_protect_required_fields_after_submission deliberately does NOT guard
  -- 'edited' status (draft/rejected/edited are the editable statuses it
  -- skips) -- and this RPC just set status = 'edited' above. A first draft of
  -- this hotfix called validate_expense_submission_invariants_v1 directly,
  -- which is CORRECT for a fresh submission but WRONG for a correction: it
  -- enforces full current-policy completeness unconditionally, which would
  -- make any legacy expense that predates a since-added required field (e.g.
  -- MicroLink's From/To location requirement) permanently uncorrectable --
  -- even for a change with nothing to do with the missing field. Corrections
  -- must not retroactively force historical records to satisfy requirements
  -- that did not exist when they were submitted; they must only be stopped
  -- from making things worse.
  --
  -- So: compare the SAME canonical structured diagnostic
  -- (expense_submission_integrity_issues_v1) before and after this
  -- correction, by identity (issue_code + issue_source + template_id +
  -- branch_field_id + field_key -- never by human-readable text or by count).
  -- An issue in the after-set is disallowed, and the whole correction is
  -- rejected (rolling back base fields + patch + logs + history together),
  -- when either:
  --   (a) it has no matching identity in the before-set (genuinely NEW), or
  --   (b) it concerns a template/branch this correction actually touched
  --       (so a legacy defect cannot be mutated into a different, or the
  --       same, defect and wave through merely because "an issue with that
  --       code already existed").
  -- An issue that is untouched AND already existed before this correction --
  -- pure legacy debt this correction had nothing to do with -- survives.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'issue_code', issue_code, 'issue_source', issue_source,
           'template_id', template_id, 'branch_field_id', branch_field_id,
           'field_key', field_key)), '[]'::jsonb)
    INTO v_issues_after
  FROM public.expense_submission_integrity_issues_v1(p_expense_id);

  SELECT jsonb_agg(after_item)
    INTO v_disallowed
  FROM jsonb_array_elements(v_issues_after) after_item
  WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_issues_before) before_item
          WHERE before_item = after_item
        )
     OR (after_item->>'template_id')::uuid = ANY (v_touched_tmpl)
     OR (after_item->>'branch_field_id')::uuid = ANY (v_touched_branch);

  IF v_disallowed IS NOT NULL AND jsonb_array_length(v_disallowed) > 0 THEN
    RAISE EXCEPTION 'This correction would leave required project/field details invalid or incomplete: %',
      (SELECT string_agg(DISTINCT COALESCE(x->>'issue_code', 'unknown'), ', ')
       FROM jsonb_array_elements(v_disallowed) x)
      USING ERRCODE = 'PW001',
            DETAIL = v_disallowed::text;
  END IF;

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
REVOKE ALL ON FUNCTION public.apply_singular_expense_correction(UUID, UUID, JSONB, TEXT, JSONB)
  FROM anon;

GRANT EXECUTE ON FUNCTION public.apply_singular_expense_correction(UUID, UUID, JSONB, TEXT, JSONB)
  TO authenticated;

COMMENT ON FUNCTION public.apply_singular_expense_correction(UUID, UUID, JSONB, TEXT, JSONB) IS
  'Atomically corrects base fields and custom field values for a single expense in one '
  'transaction. Uses explicit patch semantics (missing field = no change, never bulk-deletes). '
  'Requires org feature allow_manager_admin_expense_corrections. '
  'Authorization: admin, assigned engineer, or hierarchy reviewer '
  '(expense_hierarchy_reviewer_can_act) -- matches the live apply_expense_correction contract. '
  'Replaces the non-atomic apply_expense_correction + '
  'replace_expense_form_field_values_by_reviewer pattern. '
  'Hotfix 2026-09-09/10: deploys the previously-unapplied 290707_2000 migration with its '
  'stale role literal (invalid app_role "manager") corrected to the current contract, plus a '
  'baseline-aware no-regression integrity check: expense_submission_integrity_issues_v1 is '
  'compared before vs after (by issue_code+issue_source+template_id+branch_field_id+field_key '
  'identity), rejecting only issues that are genuinely new or concern a template/branch this '
  'correction actually touched -- pre-existing untouched legacy debt (e.g. an expense that '
  'predates a since-added required field) is never retroactively enforced, but a correction '
  'can never introduce, worsen, or mutate-in-place a required-field defect. The deferred '
  'guard protect_required_fields_after_submission does NOT cover this: it treats '
  'status=edited, which this RPC sets, as an unguarded/editable status.';

NOTIFY pgrst, 'reload schema';
