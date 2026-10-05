-- ============================================================================
-- MicroLink Atomic Submission V1
--
-- Replaces the three-mutation employee submit
--
--     INSERT/UPDATE expenses  ->  replace_expense_form_field_values  ->  PATCH status
--
-- with ONE server command that does all of it in ONE transaction.
--
-- Why this exists: the three mutations commit independently. When the
-- submission guard refuses the third, the first two are already durable and the
-- row is left as a draft. That is the 2026-09-08 incident (employee 6818, six
-- refused submissions). Core columns survived only because they are written by
-- the same statement that creates the row; custom fields are rows in another
-- table written by another call, so they had no such guarantee.
--
-- After this migration core fields and custom fields have identical persistence
-- guarantees. They still live in different tables; that is now an implementation
-- detail hidden behind one transaction.
--
-- SCOPE: MicroLink only. Every other organization keeps the current path. The
-- organization is resolved through one helper, never by comparing display names.
--
-- This migration adds functions, one column and one table. It performs NO DML
-- against existing business rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Optimistic concurrency: a monotonic revision per expense.
-- ----------------------------------------------------------------------------
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public._bump_expense_revision_v1()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Only a genuine CONTENT change bumps the revision. Bumping on every UPDATE
  -- would let unrelated writes -- reviewer assignment sync, batch aggregate
  -- refresh, supervisor changes -- invalidate a form the employee is still
  -- filling in, and the employee would be told to reload for no reason.
  IF TG_OP = 'UPDATE' AND (
       OLD.title        IS DISTINCT FROM NEW.title
    OR OLD.destination  IS DISTINCT FROM NEW.destination
    OR OLD.trip_start   IS DISTINCT FROM NEW.trip_start
    OR OLD.trip_end     IS DISTINCT FROM NEW.trip_end
    OR OLD.purpose      IS DISTINCT FROM NEW.purpose
    OR OLD.category     IS DISTINCT FROM NEW.category
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.status       IS DISTINCT FROM NEW.status
  ) THEN
    NEW.revision := COALESCE(OLD.revision, 0) + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_bump_expense_revision ON public.expenses;
CREATE TRIGGER trg_bump_expense_revision
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._bump_expense_revision_v1();

-- ----------------------------------------------------------------------------
-- 2. Submission receipts — idempotency and timeout reconciliation.
--
-- A receipt is written inside the same transaction as the submission. If the
-- HTTP response is lost, the client asks for the receipt by its own key and
-- learns what actually happened instead of guessing.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_submission_receipts (
  idempotency_key     uuid PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  expense_id          uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  action              text NOT NULL CHECK (action IN ('submit','save_draft')),
  transaction_number  text,
  status              text NOT NULL,
  revision            bigint NOT NULL,
  snapshot_hash       text NOT NULL,
  core_field_count    integer NOT NULL,
  custom_field_count  integer NOT NULL,
  committed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_submission_receipts_expense
  ON public.expense_submission_receipts (expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_submission_receipts_user
  ON public.expense_submission_receipts (user_id, committed_at DESC);

ALTER TABLE public.expense_submission_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_submission_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receipts_owner_select ON public.expense_submission_receipts;
CREATE POLICY receipts_owner_select ON public.expense_submission_receipts
  FOR SELECT USING (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3. Organization scope. One place, resolved by id — never by display name.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._microlink_organization_id_v1()
RETURNS uuid LANGUAGE sql IMMUTABLE AS $fn$
  SELECT '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid;
$fn$;

COMMENT ON FUNCTION public._microlink_organization_id_v1() IS
  'The single definition of "which organization is on atomic submission V1". '
  'Staged rollout: widen or replace with a feature flag when generalising.';

-- ----------------------------------------------------------------------------
-- 4. The MicroLink semantic field map.
--
-- The client sends business values (project_unique_id, from_location, ...).
-- The server alone knows they live in templates and option branches. MicroLink
-- templates carry no field_key, so they are resolved by their organization-
-- scoped name; a rename must fail loudly rather than silently drop a field.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._microlink_template_id_v1(p_name text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid;
BEGIN
  SELECT t.id INTO v_id
  FROM public.expense_form_field_templates t
  WHERE t.organization_id = public._microlink_organization_id_v1()
    AND t.name = p_name
    AND t.retired_at IS NULL
  ORDER BY t.created_at
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'MicroLink form configuration is missing the field "%".', p_name
      USING ERRCODE = 'PW002',
            HINT = 'An administrator must restore this field template before submissions can be saved.';
  END IF;
  RETURN v_id;
END;
$fn$;

-- Resolve Project ID / Project Name for a chosen Project Unique ID.
--
-- Derivation is deliberately HYBRID, because the live configuration is not
-- uniformly deterministic. Measured on 2026-09-09:
--     project_id   : 530 UIDs, 529 with exactly one option, 1 with two
--     project_name : 526 UIDs, 521 with one, 4 with two, 1 with none
-- and stored history agrees with derivation on 19,086/19,088 and 11,853/11,854
-- rows. So: derive when there is exactly one legal option, validate the
-- employee's choice when there are several, and refuse when there are none.
-- Never invent a value.
CREATE OR REPLACE FUNCTION public._microlink_resolve_project_fields_v1(
  p_project_unique_id text,
  p_project_id        text,
  p_project_name      text
)
RETURNS TABLE (
  project_id_branch    uuid,
  project_id_value     text,
  project_name_branch  uuid,
  project_name_value   text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_org      uuid := public._microlink_organization_id_v1();
  v_uid_tmpl uuid := public._microlink_template_id_v1('Project Unique ID');
  r          record;
  v_supplied text;
BEGIN
  project_id_branch := NULL; project_id_value := NULL;
  project_name_branch := NULL; project_name_value := NULL;

  IF NULLIF(btrim(COALESCE(p_project_unique_id,'')),'') IS NULL THEN
    -- No UID chosen. Emit an all-NULL row rather than no row, so the caller's
    -- SELECT ... INTO always has a well-defined record to read.
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates t
    WHERE t.id = v_uid_tmpl AND t.options ? btrim(p_project_unique_id)
  ) THEN
    RAISE EXCEPTION 'Project Unique ID "%" is not a valid option.', btrim(p_project_unique_id)
      USING ERRCODE = 'PW003',
            HINT = 'Choose a Project Unique ID from the list.';
  END IF;

  project_id_branch := NULL; project_id_value := NULL;
  project_name_branch := NULL; project_name_value := NULL;

  FOR r IN
    SELECT b.id, b.field_key, b.options,
           jsonb_array_length(COALESCE(b.options,'[]'::jsonb)) AS n
    FROM public.expense_form_field_option_branches b
    WHERE b.organization_id = v_org
      AND b.parent_template_id = v_uid_tmpl
      AND b.parent_option_value = btrim(p_project_unique_id)
      AND b.retired_at IS NULL
      AND b.field_key IN ('project_id','project_name')
  LOOP
    v_supplied := CASE r.field_key
                    WHEN 'project_id'   THEN NULLIF(btrim(COALESCE(p_project_id,'')),'')
                    ELSE                     NULLIF(btrim(COALESCE(p_project_name,'')),'')
                  END;

    IF r.n = 0 THEN
      RAISE EXCEPTION 'Project configuration for "%" is incomplete (% has no options).',
        btrim(p_project_unique_id), r.field_key
        USING ERRCODE = 'PW002',
              HINT = 'An administrator must configure this project before it can be used.';

    ELSIF r.n = 1 THEN
      -- Deterministic: the server derives it. A client value that disagrees is
      -- a stale form, not a preference, so it is refused rather than silently
      -- overwritten.
      IF v_supplied IS NOT NULL AND v_supplied <> (r.options->>0) THEN
        RAISE EXCEPTION 'The % sent does not match the current configuration for "%".',
          replace(r.field_key,'_',' '), btrim(p_project_unique_id)
          USING ERRCODE = 'PW003',
                HINT = 'Reload the expense form and select the project again.';
      END IF;
      IF r.field_key = 'project_id' THEN
        project_id_branch := r.id; project_id_value := r.options->>0;
      ELSE
        project_name_branch := r.id; project_name_value := r.options->>0;
      END IF;

    ELSE
      -- Genuinely ambiguous: the employee must have chosen, and the choice is
      -- validated against the current options. Nothing is invented.
      IF v_supplied IS NULL THEN
        RAISE EXCEPTION 'Project "%" has more than one %; please select one.',
          btrim(p_project_unique_id), replace(r.field_key,'_',' ')
          USING ERRCODE = 'PW001';
      END IF;
      IF NOT (r.options ? v_supplied) THEN
        RAISE EXCEPTION 'The % "%" is not valid for project "%".',
          replace(r.field_key,'_',' '), v_supplied, btrim(p_project_unique_id)
          USING ERRCODE = 'PW003';
      END IF;
      IF r.field_key = 'project_id' THEN
        project_id_branch := r.id; project_id_value := v_supplied;
      ELSE
        project_name_branch := r.id; project_name_value := v_supplied;
      END IF;
    END IF;
  END LOOP;

  RETURN NEXT;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- 5. Shared routing. Extracted from admin_submit_expense_for_employee_v2 so the
--    employee path and the admin path cannot drift apart (§29: authorization
--    differs, persistence semantics do not).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._expense_resolve_routing_v1(
  p_organization_id uuid,
  p_employee_id     uuid
)
RETURNS TABLE (approval_tier text, assigned_reviewer_id uuid, assigned_engineer_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_role text; v_flags_approval boolean; v_flags_tl boolean; v_flags_exec boolean;
  v_teams boolean; v_reporting uuid; v_sup_role text;
  v_team_id uuid; v_routing_mode text;
  v_tl uuid; v_mgr uuid; v_exec uuid; v_fallback_admin uuid;
  v_start_tier text; v_managing uuid;
BEGIN
  SELECT om.role::text INTO v_role FROM public.organization_memberships om
  WHERE om.user_id = p_employee_id AND om.organization_id = p_organization_id AND om.is_active;

  IF v_role = 'engineer' THEN
    approval_tier := NULL; assigned_reviewer_id := NULL; assigned_engineer_id := NULL;
    RETURN NEXT; RETURN;
  END IF;

  SELECT f1.enabled, f2.enabled, f3.enabled, f4.enabled
    INTO v_flags_approval, v_flags_tl, v_flags_exec, v_teams
  FROM (SELECT true) x
  LEFT JOIN public.organization_features f1
    ON f1.organization_id = p_organization_id AND f1.feature_key = 'approval_hierarchy'
  LEFT JOIN public.organization_features f2
    ON f2.organization_id = p_organization_id AND f2.feature_key = 'hierarchy_team_leader'
  LEFT JOIN public.organization_features f3
    ON f3.organization_id = p_organization_id AND f3.feature_key = 'hierarchy_executive'
  LEFT JOIN public.organization_features f4
    ON f4.organization_id = p_organization_id AND f4.feature_key = 'teams_enabled';
  v_flags_approval := COALESCE(v_flags_approval, false);
  v_flags_tl := v_flags_approval AND COALESCE(v_flags_tl, false);
  v_flags_exec := v_flags_approval AND COALESCE(v_flags_exec, false);
  v_teams := COALESCE(v_teams, false);

  SELECT p.reporting_engineer_id INTO v_reporting FROM public.profiles p
  WHERE p.user_id = p_employee_id AND p.organization_id = p_organization_id;

  IF v_reporting IS NOT NULL THEN
    SELECT om.role::text INTO v_sup_role FROM public.organization_memberships om
    WHERE om.user_id = v_reporting AND om.organization_id = p_organization_id AND om.is_active;
  END IF;

  IF NOT v_flags_approval THEN
    approval_tier := NULL; assigned_reviewer_id := v_reporting; assigned_engineer_id := v_reporting;
    RETURN NEXT; RETURN;
  END IF;

  IF v_teams THEN
    SELECT t.id, t.routing_mode, t.team_leader_user_id, t.manager_user_id, t.executive_user_id
      INTO v_team_id, v_routing_mode, v_tl, v_mgr, v_exec
    FROM public.team_members tm
    JOIN public.teams t ON t.id = tm.team_id AND t.organization_id = p_organization_id
    WHERE tm.user_id = p_employee_id AND tm.organization_id = p_organization_id
    LIMIT 1;
  END IF;

  SELECT om.user_id INTO v_fallback_admin FROM public.organization_memberships om
  WHERE om.organization_id = p_organization_id AND om.role = 'admin' AND om.is_active LIMIT 1;

  v_start_tier := public._admin_submit_adjust_start_tier_v1(
    public._admin_submit_first_tier_v1(v_flags_tl, v_flags_exec, v_routing_mode),
    v_role, v_flags_tl, v_flags_exec);

  SELECT a.approval_tier, a.assigned_reviewer_id, a.assigned_engineer_id
    INTO approval_tier, assigned_reviewer_id, assigned_engineer_id
  FROM public._admin_submit_resolve_assignment_v1(
    v_flags_tl, v_flags_exec, v_start_tier, v_reporting, v_sup_role,
    v_tl, v_mgr, v_exec, v_fallback_admin) a;

  SELECT a.assigned_reviewer_id INTO v_managing
  FROM public._admin_submit_resolve_assignment_v1(
    v_flags_tl, v_flags_exec, 'engineer', v_reporting, v_sup_role,
    v_tl, v_mgr, v_exec, v_fallback_admin) a
  WHERE a.approval_tier = 'engineer';
  IF v_managing IS NOT NULL THEN assigned_engineer_id := v_managing; END IF;

  RETURN NEXT;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- 6. Canonical snapshot hash — proves what the server accepted equals what it
--    persisted. Business values only; never timestamps or ids.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._expense_snapshot_hash_v1(p_expense_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT md5(
    concat_ws('|',
      COALESCE(e.title, ''),
      COALESCE(e.destination, ''),
      COALESCE(e.trip_start::text, ''),
      COALESCE(e.trip_end::text, ''),
      COALESCE(e.category, ''),
      COALESCE(round(e.total_amount, 2)::text, ''),
      COALESCE(e.purpose, ''),
      COALESCE((
        SELECT string_agg(
                 COALESCE(v.template_id::text, v.branch_field_id::text) || '=' || v.field_value,
                 ';' ORDER BY COALESCE(v.template_id::text, v.branch_field_id::text))
        FROM public.expense_form_field_values v
        WHERE v.expense_id = e.id), '')
    )
  )
  FROM public.expenses e
  WHERE e.id = p_expense_id;
$fn$;

-- ----------------------------------------------------------------------------
-- 7. Narrow UPSERT helpers. These write onto the existing UNIQUE constraints
--    uq_form_field_values_expense_template / _expense_branch, so a value is
--    never momentarily absent the way delete-then-insert would leave it.
--    An empty/NULL value is an explicit CLEAR for a field that IS in scope.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._microlink_upsert_template_value_v1(
  p_expense_id uuid, p_template_id uuid, p_value text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_clean text := NULLIF(btrim(COALESCE(p_value,'')),'');
BEGIN
  IF p_template_id IS NULL THEN RETURN; END IF;

  IF v_clean IS NULL THEN
    DELETE FROM public.expense_form_field_values
    WHERE expense_id = p_expense_id AND template_id = p_template_id;
    RETURN;
  END IF;

  INSERT INTO public.expense_form_field_values
    (organization_id, expense_id, template_id, branch_field_id, field_value)
  SELECT e.organization_id, p_expense_id, p_template_id, NULL, v_clean
  FROM public.expenses e WHERE e.id = p_expense_id
  ON CONFLICT (expense_id, template_id)
  DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = now();
END;
$fn$;

CREATE OR REPLACE FUNCTION public._microlink_upsert_branch_value_v1(
  p_expense_id uuid, p_branch_field_id uuid, p_value text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_clean text := NULLIF(btrim(COALESCE(p_value,'')),'');
BEGIN
  IF p_branch_field_id IS NULL THEN RETURN; END IF;

  IF v_clean IS NULL THEN
    DELETE FROM public.expense_form_field_values
    WHERE expense_id = p_expense_id AND branch_field_id = p_branch_field_id;
    RETURN;
  END IF;

  INSERT INTO public.expense_form_field_values
    (organization_id, expense_id, template_id, branch_field_id, field_value)
  SELECT e.organization_id, p_expense_id, NULL, p_branch_field_id, v_clean
  FROM public.expenses e WHERE e.id = p_expense_id
  ON CONFLICT (expense_id, branch_field_id)
  DO UPDATE SET field_value = EXCLUDED.field_value, updated_at = now();
END;
$fn$;

-- ----------------------------------------------------------------------------
-- 8. THE ENGINE. One implementation; the public wrappers differ only in the
--    action they request, so save-draft and submit cannot drift apart.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._persist_microlink_expense_snapshot_v1(
  p_snapshot jsonb,
  p_action   text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_org        uuid := public._microlink_organization_id_v1();
  v_uid        uuid := auth.uid();
  v_key        uuid;
  v_expense_id uuid;
  v_expected   bigint;
  v_existing   public.expenses%ROWTYPE;
  v_core       jsonb;
  v_ml         jsonb;
  v_receipt    public.expense_submission_receipts%ROWTYPE;
  v_status     text;
  v_tier       text;
  v_reviewer   uuid;
  v_engineer   uuid;
  v_proj       record;
  v_tmpl_uid   uuid;
  v_tmpl_from  uuid;
  v_tmpl_to    uuid;
  v_field_n    integer;
  v_row        jsonb;
BEGIN
  IF p_action NOT IN ('submit','save_draft') THEN
    RAISE EXCEPTION 'invalid action %', p_action USING ERRCODE = '22023';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  v_key := NULLIF(p_snapshot->>'idempotency_key','')::uuid;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required' USING ERRCODE = '22023';
  END IF;

  ---------------------------------------------------------------------------
  -- IDEMPOTENCY, answered before anything is written, so a retry after a lost
  -- response returns the original receipt instead of creating a second expense.
  ---------------------------------------------------------------------------
  SELECT * INTO v_receipt FROM public.expense_submission_receipts
  WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF v_receipt.user_id <> v_uid THEN
      RAISE EXCEPTION 'idempotency key belongs to another user' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
      'committed', true, 'replayed', true,
      'expense_id', v_receipt.expense_id,
      'transaction_number', v_receipt.transaction_number,
      'status', v_receipt.status,
      'revision', v_receipt.revision,
      'submitted_at', v_receipt.committed_at,
      'snapshot_hash', v_receipt.snapshot_hash,
      'persisted_core_fields', v_receipt.core_field_count,
      'persisted_custom_fields', v_receipt.custom_field_count,
      'idempotency_key', v_receipt.idempotency_key);
  END IF;

  ---------------------------------------------------------------------------
  -- AUTHORIZATION. MicroLink only; the caller must be an active member.
  ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = v_org AND om.is_active
  ) THEN
    RAISE EXCEPTION 'This expense endpoint is not available for your organization.'
      USING ERRCODE = '42501';
  END IF;

  v_core  := COALESCE(p_snapshot->'core', '{}'::jsonb);
  v_ml    := COALESCE(p_snapshot->'microlink', '{}'::jsonb);
  v_expense_id := NULLIF(p_snapshot->>'expense_id','')::uuid;
  v_expected   := NULLIF(p_snapshot->>'expected_revision','')::bigint;

  ---------------------------------------------------------------------------
  -- LOCK + OPTIMISTIC CONCURRENCY
  ---------------------------------------------------------------------------
  IF v_expense_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.expenses WHERE id = v_expense_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_existing.organization_id <> v_org THEN
      RAISE EXCEPTION 'Expense belongs to another organization' USING ERRCODE = '42501';
    END IF;
    IF v_existing.user_id <> v_uid THEN
      RAISE EXCEPTION 'You do not own this expense' USING ERRCODE = '42501';
    END IF;
    IF v_existing.status::text NOT IN ('draft','rejected') THEN
      RAISE EXCEPTION 'This expense can no longer be edited (status %).', v_existing.status
        USING ERRCODE = '22023';
    END IF;
    IF v_expected IS NOT NULL AND COALESCE(v_existing.revision,0) <> v_expected THEN
      RAISE EXCEPTION 'This expense changed in another session. Reload before submitting.'
        USING ERRCODE = 'PW409';
    END IF;
  END IF;

  ---------------------------------------------------------------------------
  -- RESOLVE THE MICROLINK SEMANTIC FIELDS. The client never sends uuids.
  ---------------------------------------------------------------------------
  v_tmpl_uid  := public._microlink_template_id_v1('Project Unique ID');
  v_tmpl_from := public._microlink_template_id_v1('From location');
  v_tmpl_to   := public._microlink_template_id_v1('To location');

  SELECT * INTO v_proj FROM public._microlink_resolve_project_fields_v1(
    v_ml->>'project_unique_id', v_ml->>'project_id', v_ml->>'project_name');

  ---------------------------------------------------------------------------
  -- CORE WRITE
  ---------------------------------------------------------------------------
  v_status := CASE WHEN p_action = 'submit' THEN 'submitted' ELSE 'draft' END;

  IF p_action = 'submit' THEN
    SELECT r.approval_tier, r.assigned_reviewer_id, r.assigned_engineer_id
      INTO v_tier, v_reviewer, v_engineer
    FROM public._expense_resolve_routing_v1(v_org, v_uid) r;
  END IF;

  IF v_expense_id IS NULL THEN
    INSERT INTO public.expenses (
      user_id, organization_id, title, destination, trip_start, trip_end,
      purpose, category, total_amount, status, approval_tier,
      assigned_reviewer_id, assigned_engineer_id
    ) VALUES (
      v_uid, v_org,
      v_core->>'title', v_core->>'destination',
      (v_core->>'trip_start')::date,
      COALESCE((v_core->>'trip_end')::date, (v_core->>'trip_start')::date),
      v_core->>'purpose', v_core->>'category',
      (v_core->>'total_amount')::numeric,
      v_status::public.expense_status, v_tier, v_reviewer, v_engineer
    ) RETURNING id INTO v_expense_id;
  ELSE
    UPDATE public.expenses SET
      title = v_core->>'title',
      destination = v_core->>'destination',
      trip_start = (v_core->>'trip_start')::date,
      trip_end = COALESCE((v_core->>'trip_end')::date, (v_core->>'trip_start')::date),
      purpose = v_core->>'purpose',
      category = v_core->>'category',
      total_amount = (v_core->>'total_amount')::numeric,
      status = CASE WHEN p_action = 'submit'
                    THEN v_status::public.expense_status ELSE status END,
      approval_tier = CASE WHEN p_action = 'submit' THEN v_tier ELSE approval_tier END,
      assigned_reviewer_id = CASE WHEN p_action = 'submit' THEN v_reviewer ELSE assigned_reviewer_id END,
      assigned_engineer_id = CASE WHEN p_action = 'submit' THEN v_engineer ELSE assigned_engineer_id END,
      updated_at = now()
    WHERE id = v_expense_id;
  END IF;

  ---------------------------------------------------------------------------
  -- CUSTOM FIELD WRITE — same transaction, narrow upserts.
  ---------------------------------------------------------------------------
  PERFORM public._microlink_upsert_template_value_v1(
    v_expense_id, v_tmpl_uid, v_ml->>'project_unique_id');
  PERFORM public._microlink_upsert_template_value_v1(
    v_expense_id, v_tmpl_from, v_ml->>'from_location');
  PERFORM public._microlink_upsert_template_value_v1(
    v_expense_id, v_tmpl_to, v_ml->>'to_location');

  IF v_proj.project_id_branch IS NOT NULL THEN
    PERFORM public._microlink_upsert_branch_value_v1(
      v_expense_id, v_proj.project_id_branch, v_proj.project_id_value);
  END IF;
  IF v_proj.project_name_branch IS NOT NULL THEN
    PERFORM public._microlink_upsert_branch_value_v1(
      v_expense_id, v_proj.project_name_branch, v_proj.project_name_value);
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(
      COALESCE(p_snapshot->'additional_fields','[]'::jsonb))
  LOOP
    PERFORM public._microlink_upsert_template_value_v1(
      v_expense_id, (v_row->>'template_id')::uuid, v_row->>'value');
  END LOOP;

  -- Branch rows belonging to a project the employee is no longer on. Scoped to
  -- THIS expense and THIS parent template only, so an absent key can never
  -- delete anything outside the scope the snapshot actually covers.
  DELETE FROM public.expense_form_field_values v
  USING public.expense_form_field_option_branches b
  WHERE v.expense_id = v_expense_id
    AND v.branch_field_id = b.id
    AND b.parent_template_id = v_tmpl_uid
    AND v.branch_field_id IS DISTINCT FROM v_proj.project_id_branch
    AND v.branch_field_id IS DISTINCT FROM v_proj.project_name_branch;

  ---------------------------------------------------------------------------
  -- READBACK VERIFICATION — validates the rows ACTUALLY WRITTEN, not the JSON.
  ---------------------------------------------------------------------------
  IF p_action = 'submit' THEN
    PERFORM public.validate_expense_submission_invariants_v1(v_expense_id);
    -- Force the deferred constraint triggers now, so a failure rolls back
    -- inside this call rather than surfacing at COMMIT with no context.
    SET CONSTRAINTS ALL IMMEDIATE;
    -- ...then put them back. SET CONSTRAINTS applies to the whole transaction,
    -- not to this function: leaving them IMMEDIATE would make the NEXT row in a
    -- batch fire the submission guard on its INSERT, before its custom fields
    -- have been written, and fail a perfectly valid expense.
    SET CONSTRAINTS ALL DEFERRED;
  END IF;

  SELECT count(*) INTO v_field_n
  FROM public.expense_form_field_values WHERE expense_id = v_expense_id;

  SELECT * INTO v_existing FROM public.expenses WHERE id = v_expense_id;

  IF p_action = 'submit' THEN
    IF v_existing.status::text <> 'submitted' THEN
      RAISE EXCEPTION 'submission did not reach the submitted state' USING ERRCODE = 'PW500';
    END IF;
    IF v_existing.transaction_number IS NULL THEN
      RAISE EXCEPTION 'submission reached submitted without a transaction number'
        USING ERRCODE = 'PW500';
    END IF;

    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (v_expense_id, v_uid, v_org, 'expense_submitted',
            'Submitted via atomic snapshot V1');
  END IF;

  ---------------------------------------------------------------------------
  -- RECEIPT — written in the same transaction as everything it describes.
  ---------------------------------------------------------------------------
  INSERT INTO public.expense_submission_receipts (
    idempotency_key, organization_id, user_id, expense_id, action,
    transaction_number, status, revision, snapshot_hash,
    core_field_count, custom_field_count)
  VALUES (
    v_key, v_org, v_uid, v_expense_id, p_action,
    v_existing.transaction_number, v_existing.status::text,
    COALESCE(v_existing.revision,0),
    public._expense_snapshot_hash_v1(v_expense_id),
    (SELECT count(*) FROM jsonb_object_keys(v_core)), v_field_n);

  RETURN jsonb_build_object(
    'committed', true, 'replayed', false,
    'expense_id', v_expense_id,
    'transaction_number', v_existing.transaction_number,
    'status', v_existing.status::text,
    'revision', COALESCE(v_existing.revision,0),
    'submitted_at', now(),
    'snapshot_hash', public._expense_snapshot_hash_v1(v_expense_id),
    'persisted_core_fields', (SELECT count(*) FROM jsonb_object_keys(v_core)),
    'persisted_custom_fields', v_field_n,
    'idempotency_key', v_key);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- 9. Public wrappers. Thin by design — one engine, no drift.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_microlink_expense_v1(p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public._persist_microlink_expense_snapshot_v1(p_snapshot, 'submit');
$fn$;

CREATE OR REPLACE FUNCTION public.save_microlink_expense_draft_v1(p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public._persist_microlink_expense_snapshot_v1(p_snapshot, 'save_draft');
$fn$;

-- Timeout reconciliation: what actually happened for this attempt?
CREATE OR REPLACE FUNCTION public.get_expense_submission_result_v1(p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid uuid := auth.uid(); r public.expense_submission_receipts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO r FROM public.expense_submission_receipts
  WHERE idempotency_key = p_idempotency_key AND user_id = v_uid;
  IF NOT FOUND THEN
    -- Absence is NOT proof of failure while a request may still be in flight;
    -- the client decides using its own elapsed time. We only report what we know.
    RETURN jsonb_build_object('committed', false, 'known', false);
  END IF;
  RETURN jsonb_build_object(
    'committed', true, 'known', true,
    'expense_id', r.expense_id, 'transaction_number', r.transaction_number,
    'status', r.status, 'revision', r.revision, 'submitted_at', r.committed_at,
    'snapshot_hash', r.snapshot_hash, 'idempotency_key', r.idempotency_key);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- 10. Batch. Owner-approved Option C: validate everything, commit all or none;
--     a caller may opt into the valid subset only by asking explicitly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_microlink_expense_batch_v1(
  p_snapshots jsonb,
  p_allow_partial boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_snap jsonb; v_res jsonb;
  v_ok jsonb := '[]'::jsonb;
  v_bad jsonb := '[]'::jsonb;
  v_idx int := 0;
BEGIN
  IF jsonb_typeof(p_snapshots) <> 'array' THEN
    RAISE EXCEPTION 'p_snapshots must be an array' USING ERRCODE = '22023';
  END IF;

  -- Pass 1 — DRY RUN. Each row is attempted inside its own implicit savepoint
  -- and then deliberately undone by raising a sentinel. Nothing from this pass
  -- survives; it exists so a bad row can be reported without its siblings having
  -- already committed. 'PWDRY' is a deliberately chosen 5-character SQLSTATE:
  -- Postgres only accepts exactly five characters from [0-9A-Z].
  FOR v_snap IN SELECT * FROM jsonb_array_elements(p_snapshots) LOOP
    v_idx := v_idx + 1;
    BEGIN
      PERFORM public._persist_microlink_expense_snapshot_v1(
        -- a dry run must not consume the caller's real idempotency key
        jsonb_set(v_snap, '{idempotency_key}', to_jsonb(gen_random_uuid()::text)),
        'submit');
      RAISE EXCEPTION 'dry run' USING ERRCODE = 'PWDRY';
    EXCEPTION
      WHEN SQLSTATE 'PWDRY' THEN
        NULL;  -- this row is valid; its writes were rolled back with the sentinel
      WHEN others THEN
        v_bad := v_bad || jsonb_build_object(
          'index', v_idx, 'sqlstate', SQLSTATE, 'message', SQLERRM,
          'title', v_snap #>> '{core,title}');
    END;
  END LOOP;

  IF jsonb_array_length(v_bad) > 0 AND NOT p_allow_partial THEN
    RETURN jsonb_build_object(
      'batch_valid', false, 'committed', false,
      'submitted_count', 0,
      'failed', v_bad,
      'hint', 'Nothing was submitted. Fix the listed rows, or resubmit with '
              'p_allow_partial to send only the valid ones.');
  END IF;

  -- Pass 2: commit for real.
  v_idx := 0; v_ok := '[]'::jsonb;
  FOR v_snap IN SELECT * FROM jsonb_array_elements(p_snapshots) LOOP
    v_idx := v_idx + 1;
    IF p_allow_partial AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_bad) b WHERE (b->>'index')::int = v_idx
    ) THEN
      CONTINUE;
    END IF;
    v_res := public._persist_microlink_expense_snapshot_v1(v_snap, 'submit');
    v_ok := v_ok || jsonb_build_object('index', v_idx, 'receipt', v_res);
  END LOOP;

  RETURN jsonb_build_object(
    'batch_valid', jsonb_array_length(v_bad) = 0,
    'committed', true,
    'submitted_count', jsonb_array_length(v_ok),
    'submitted', v_ok,
    'failed', v_bad);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- 11. Grants. `anon` is revoked explicitly: this stack carries ALTER DEFAULT
--     PRIVILEGES granting EXECUTE on new public functions to anon directly, so
--     REVOKE ... FROM PUBLIC alone is not sufficient.
-- ----------------------------------------------------------------------------
DO $grants$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.submit_microlink_expense_v1(jsonb)',
    'public.save_microlink_expense_draft_v1(jsonb)',
    'public.get_expense_submission_result_v1(uuid)',
    'public.submit_microlink_expense_batch_v1(jsonb, boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;

  -- Internal helpers. `authenticated` is revoked EXPLICITLY, not just PUBLIC and
  -- anon, because this stack's ALTER DEFAULT PRIVILEGES grants EXECUTE on every
  -- new public function to `authenticated` directly — so the role keeps it in
  -- its own right and REVOKE ... FROM PUBLIC does nothing.
  --
  -- This matters: `_microlink_upsert_template_value_v1` and its branch twin are
  -- SECURITY DEFINER and take an expense id WITHOUT checking ownership, because
  -- the engine has already authorized the caller before reaching them. Left
  -- executable by `authenticated`, any signed-in user could write custom field
  -- values onto any expense in any organization. The public wrappers are
  -- unaffected: they are SECURITY DEFINER, so they call these as the owner.
  FOREACH fn IN ARRAY ARRAY[
    'public._persist_microlink_expense_snapshot_v1(jsonb, text)',
    'public._microlink_upsert_template_value_v1(uuid, uuid, text)',
    'public._microlink_upsert_branch_value_v1(uuid, uuid, text)',
    'public._microlink_resolve_project_fields_v1(text, text, text)',
    'public._microlink_template_id_v1(text)',
    'public._expense_resolve_routing_v1(uuid, uuid)',
    'public._expense_snapshot_hash_v1(uuid)',
    'public._microlink_organization_id_v1()',
    'public._bump_expense_revision_v1()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END;
$grants$;

GRANT SELECT ON public.expense_submission_receipts TO authenticated;

COMMENT ON FUNCTION public.submit_microlink_expense_v1(jsonb) IS
  'Atomic MicroLink submission. ONE request persists core fields, every custom '
  'and conditional branch value, the transaction number, the submitted status, '
  'the audit event and an idempotency receipt in ONE transaction. Any failure '
  'rolls back all of it - there is no state in which the core row is submitted '
  'while its custom fields are missing.';
