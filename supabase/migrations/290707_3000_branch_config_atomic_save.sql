-- ── PEsoWise · DOC-047: Branch Config Atomic Save & Data-Integrity Repair ────
-- Migration: 290707_3000_branch_config_atomic_save.sql
-- Purpose : Replace the browser-side DELETE+INSERT pattern with a
--           server-side atomic save RPC.  Adds soft retirement, a
--           configuration audit trail, and a BEFORE DELETE guard.
--
-- ⚠  Do NOT apply to any Supabase project until the matching frontend
--    changes (CategoryManagement.tsx, optionBranchPersistence.ts) are
--    deployed.  Both must land together.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── E1.  Soft-retirement columns ─────────────────────────────────────────────

ALTER TABLE public.expense_form_field_option_branches
  ADD COLUMN IF NOT EXISTS retired_at     timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by     uuid
    REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retired_reason text;

COMMENT ON COLUMN public.expense_form_field_option_branches.retired_at IS
  'NULL = active.  Set to now() to retire without physical deletion.';
COMMENT ON COLUMN public.expense_form_field_option_branches.retired_by IS
  'auth.uid() of the admin who retired this row.';
COMMENT ON COLUMN public.expense_form_field_option_branches.retired_reason IS
  'Short code: removed_from_configuration | superseded | manual_repair';

-- ── E2.  Rebuild unique indexes to exclude retired rows ───────────────────────

DROP INDEX IF EXISTS public.idx_option_branches_root_field_key;
CREATE UNIQUE INDEX idx_option_branches_root_field_key
  ON public.expense_form_field_option_branches
  (parent_template_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NULL
    AND retired_at IS NULL;

DROP INDEX IF EXISTS public.idx_option_branches_nested_field_key;
CREATE UNIQUE INDEX idx_option_branches_nested_field_key
  ON public.expense_form_field_option_branches
  (parent_branch_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NOT NULL
    AND retired_at IS NULL;

-- ── E3.  Configuration revision audit table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_form_field_branch_config_revisions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  template_id             uuid        NOT NULL
    REFERENCES public.expense_form_field_templates (id) ON DELETE CASCADE,
  changed_by              uuid
    REFERENCES auth.users (id) ON DELETE SET NULL,
  source                  text        NOT NULL DEFAULT 'unknown',
  reason                  text,
  parent_options_snapshot jsonb       NOT NULL DEFAULT '[]',
  branches_inserted       integer     NOT NULL DEFAULT 0,
  branches_updated        integer     NOT NULL DEFAULT 0,
  branches_retired        integer     NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.expense_form_field_branch_config_revisions IS
  'Append-only audit log: one row per call to save_option_branch_configuration_atomically.';

ALTER TABLE public.expense_form_field_branch_config_revisions
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view branch config revisions"
  ON public.expense_form_field_branch_config_revisions;
CREATE POLICY "Admins can view branch config revisions"
  ON public.expense_form_field_branch_config_revisions FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

-- The SECURITY DEFINER RPC bypasses RLS on INSERT; this policy is a belt-and-
-- suspenders guard for any future direct-insert path.
DROP POLICY IF EXISTS "SECURITY DEFINER RPC may insert revisions"
  ON public.expense_form_field_branch_config_revisions;
CREATE POLICY "SECURITY DEFINER RPC may insert revisions"
  ON public.expense_form_field_branch_config_revisions FOR INSERT
  WITH CHECK (true);

-- ── G.  BEFORE DELETE guard trigger ─────────────────────────────────────────
--
-- Blocks direct PostgREST DELETE calls to expense_form_field_option_branches.
-- The approved RPC sets app.branch_write_context before any DML that causes a
-- DELETE, so that path is explicitly allowed.
-- Cascade deletes from parent table deletion are detected by request.path not
-- containing 'expense_form_field_option_branches' (PostgREST sets request.path
-- to the table being called directly).

CREATE OR REPLACE FUNCTION public.block_direct_branch_delete ()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _ctx  text;
  _path text;
BEGIN
  _ctx  := coalesce(current_setting('app.branch_write_context', TRUE), '');
  _path := coalesce(current_setting('request.path',             TRUE), '');

  -- Allow: write context set by the approved atomic-save RPC
  IF _ctx = 'save_option_branch_configuration_atomically' THEN
    RETURN OLD;
  END IF;

  -- Allow: not a direct PostgREST DELETE targeting this table
  -- (e.g. cascade from template/org deletion, or SQL editor)
  IF position('expense_form_field_option_branches' IN _path) = 0 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Direct DELETE on expense_form_field_option_branches is not permitted. '
    'Use the save_option_branch_configuration_atomically RPC instead.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_direct_branch_delete
  ON public.expense_form_field_option_branches;
CREATE TRIGGER trg_block_direct_branch_delete
  BEFORE DELETE ON public.expense_form_field_option_branches
  FOR EACH ROW
  EXECUTE FUNCTION public.block_direct_branch_delete();

-- ── F.  Atomic branch configuration save RPC ─────────────────────────────────
--
-- p_branches element JSON schema (one object per draft branch):
--   local_id           text     required — browser-generated UUID
--   db_id              text     nullable — null for new branches, uuid for existing
--   parent_option_value text    required
--   parent_local_id    text     nullable — null for root branches
--   field_key          text     required
--   name               text     required
--   field_type         text     required (text|number|date|textarea|select|checkbox)
--   required           boolean  required
--   placeholder        text     nullable
--   help_text          text     nullable
--   options            jsonb    nullable — array of strings for select/checkbox
--   display_order      integer  required
--
-- Returns jsonb:
--   { ok, revision_id, latest_updated_at, branches_inserted,
--     branches_updated, branches_retired }
--
-- Error codes raised:
--   'P0001' — stale_edit: (p_expected_updated_at mismatch)
--   'P0002' — project_integrity: (Project template missing required branches)

CREATE OR REPLACE FUNCTION public.save_option_branch_configuration_atomically (
  p_organization_id     uuid,
  p_template_id         uuid,
  p_expected_updated_at timestamptz,   -- NULL = new template, skip stale check
  p_parent_options      jsonb,         -- jsonb array of option strings
  p_branches            jsonb,         -- jsonb array of branch objects
  p_source              text  DEFAULT 'category_management',
  p_reason              text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_updated_at   timestamptz;
  v_valid_parent_options text[]  := ARRAY[]::text[];
  v_opt                  text;
  v_branch               jsonb;
  v_db_id                uuid;
  v_new_id               uuid;
  v_parent_local_id      text;
  v_parent_db_id         uuid;
  v_payload_db_ids       uuid[]  := ARRAY[]::uuid[];
  v_local_to_db          jsonb   := '{}'::jsonb;
  v_branches_inserted    integer := 0;
  v_branches_updated     integer := 0;
  v_branches_retired     integer := 0;
  v_prev_remaining       integer := -1;
  v_remaining_count      integer;
  v_revision_id          uuid;
  v_missing_option       text;
BEGIN

  -- ── 1.  Authorisation: caller must be an active admin in the org ──────────
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id
      AND user_id         = auth.uid()
      AND is_active       = true
      AND role            = 'admin'
  ) THEN
    RAISE EXCEPTION 'Permission denied: admin role required in organisation %',
      p_organization_id;
  END IF;

  -- ── 2.  Lock the template row (prevents concurrent saves) ─────────────────
  SELECT t.updated_at INTO v_current_updated_at
  FROM   public.expense_form_field_templates t
  WHERE  t.id              = p_template_id
    AND  t.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  -- ── 3.  Stale-edit detection ───────────────────────────────────────────────
  IF p_expected_updated_at IS NOT NULL
     AND v_current_updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION
      'stale_edit: Template configuration was modified by another session. '
      'Close and reopen the editor to reload the latest version.'
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 4.  Normalise and deduplicate parent options ──────────────────────────
  FOR v_opt IN
    SELECT DISTINCT trim(x.val)
    FROM   jsonb_array_elements_text(p_parent_options) AS x(val)
    WHERE  trim(x.val) <> ''
  LOOP
    v_valid_parent_options := array_append(v_valid_parent_options, v_opt);
  END LOOP;

  IF array_length(v_valid_parent_options, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one non-empty parent option is required';
  END IF;

  -- ── 5.  Validate branch payload ────────────────────────────────────────────
  FOR v_branch IN
    SELECT value FROM jsonb_array_elements(p_branches)
  LOOP
    IF coalesce(trim(v_branch->>'name'),     '') = '' THEN
      RAISE EXCEPTION 'Branch name cannot be empty (local_id=%)',
        v_branch->>'local_id';
    END IF;
    IF coalesce(trim(v_branch->>'field_key'), '') = '' THEN
      RAISE EXCEPTION 'Branch field_key cannot be empty (local_id=%)',
        v_branch->>'local_id';
    END IF;
    IF (v_branch->>'field_type') NOT IN
         ('text','number','date','textarea','select','checkbox') THEN
      RAISE EXCEPTION 'Invalid field_type "%" (local_id=%)',
        v_branch->>'field_type', v_branch->>'local_id';
    END IF;
  END LOOP;

  -- ── 6.  Project-specific completeness check ───────────────────────────────
  --    Template 51181324-68cc-4174-bbe0-4834e5e22c48 ("Project Unique ID")
  --    must carry both field_key='project_id' and field_key='project_name'
  --    for every parent option value (root level, parent_local_id IS NULL).
  IF p_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48'::uuid THEN
    SELECT opt INTO v_missing_option
    FROM   unnest(v_valid_parent_options) AS opt
    WHERE  NOT (
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_branches) AS b
        WHERE  b.value->>'parent_option_value' = opt
          AND  b.value->>'field_key'            = 'project_id'
          AND  (b.value->>'parent_local_id')    IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_branches) AS b
        WHERE  b.value->>'parent_option_value' = opt
          AND  b.value->>'field_key'            = 'project_name'
          AND  (b.value->>'parent_local_id')    IS NULL
      )
    )
    LIMIT 1;

    IF v_missing_option IS NOT NULL THEN
      RAISE EXCEPTION
        'project_integrity: Parent option "%" is missing a required '
        'project_id or project_name root branch', v_missing_option
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- ── 7.  Arm the write context (allows retirement UPDATEs; no DELETEs used) ─
  PERFORM set_config('app.branch_write_context',
                     'save_option_branch_configuration_atomically', TRUE);

  -- ── 8.  Pass 1 — root branches (parent_local_id IS NULL) ──────────────────
  FOR v_branch IN
    SELECT value FROM jsonb_array_elements(p_branches)
    WHERE  (value->>'parent_local_id') IS NULL
  LOOP
    v_db_id := nullif(v_branch->>'db_id', '')::uuid;

    IF v_db_id IS NOT NULL THEN
      -- UPDATE existing row (un-retire if needed)
      UPDATE public.expense_form_field_option_branches
      SET
        parent_option_value = trim(v_branch->>'parent_option_value'),
        field_key           = trim(v_branch->>'field_key'),
        name                = trim(v_branch->>'name'),
        field_type          = v_branch->>'field_type',
        required            = (v_branch->>'required')::boolean,
        placeholder         = NULLIF(trim(v_branch->>'placeholder'), ''),
        help_text           = NULLIF(trim(v_branch->>'help_text'),   ''),
        options             = CASE
                                WHEN (v_branch->>'field_type') IN ('select','checkbox')
                                THEN v_branch->'options'
                                ELSE NULL
                              END,
        display_order       = (v_branch->>'display_order')::integer,
        retired_at          = NULL,
        retired_by          = NULL,
        retired_reason      = NULL,
        updated_at          = now()
      WHERE  id                  = v_db_id
        AND  parent_template_id  = p_template_id
        AND  organization_id     = p_organization_id;

      v_local_to_db    := v_local_to_db
                          || jsonb_build_object(v_branch->>'local_id', v_db_id::text);
      v_payload_db_ids := array_append(v_payload_db_ids, v_db_id);
      v_branches_updated := v_branches_updated + 1;

    ELSE
      -- INSERT new row
      INSERT INTO public.expense_form_field_option_branches (
        organization_id, parent_template_id, parent_option_value,
        parent_branch_id, field_key, name, field_type, required,
        placeholder, help_text, options, display_order
      ) VALUES (
        p_organization_id,
        p_template_id,
        trim(v_branch->>'parent_option_value'),
        NULL,
        trim(v_branch->>'field_key'),
        trim(v_branch->>'name'),
        v_branch->>'field_type',
        (v_branch->>'required')::boolean,
        NULLIF(trim(v_branch->>'placeholder'), ''),
        NULLIF(trim(v_branch->>'help_text'),   ''),
        CASE
          WHEN (v_branch->>'field_type') IN ('select','checkbox')
          THEN v_branch->'options'
          ELSE NULL
        END,
        (v_branch->>'display_order')::integer
      )
      RETURNING id INTO v_new_id;

      v_local_to_db    := v_local_to_db
                          || jsonb_build_object(v_branch->>'local_id', v_new_id::text);
      v_payload_db_ids := array_append(v_payload_db_ids, v_new_id);
      v_branches_inserted := v_branches_inserted + 1;
    END IF;
  END LOOP;

  -- ── 9.  Pass 2+ — nested branches (parent_local_id NOT NULL) ──────────────
  --    Iterate until every nested branch is processed or no progress is made
  --    (cycle detection via v_prev_remaining guard).
  LOOP
    -- Count unprocessed nested branches whose parent is not yet resolved
    SELECT count(*) INTO v_remaining_count
    FROM   jsonb_array_elements(p_branches)
    WHERE  (value->>'parent_local_id') IS NOT NULL
      AND  NOT (v_local_to_db ? (value->>'local_id'));

    EXIT WHEN v_remaining_count = 0;
    EXIT WHEN v_remaining_count = v_prev_remaining;  -- no progress → graph cycle
    v_prev_remaining := v_remaining_count;

    FOR v_branch IN
      SELECT value FROM jsonb_array_elements(p_branches)
      WHERE  (value->>'parent_local_id') IS NOT NULL
        AND  v_local_to_db ? (value->>'parent_local_id')
        AND  NOT (v_local_to_db ? (value->>'local_id'))
    LOOP
      v_parent_local_id := v_branch->>'parent_local_id';
      v_parent_db_id    := (v_local_to_db ->> v_parent_local_id)::uuid;
      v_db_id           := nullif(v_branch->>'db_id', '')::uuid;

      IF v_db_id IS NOT NULL THEN
        UPDATE public.expense_form_field_option_branches
        SET
          parent_option_value = trim(v_branch->>'parent_option_value'),
          parent_branch_id    = v_parent_db_id,
          field_key           = trim(v_branch->>'field_key'),
          name                = trim(v_branch->>'name'),
          field_type          = v_branch->>'field_type',
          required            = (v_branch->>'required')::boolean,
          placeholder         = NULLIF(trim(v_branch->>'placeholder'), ''),
          help_text           = NULLIF(trim(v_branch->>'help_text'),   ''),
          options             = CASE
                                  WHEN (v_branch->>'field_type') IN ('select','checkbox')
                                  THEN v_branch->'options'
                                  ELSE NULL
                                END,
          display_order       = (v_branch->>'display_order')::integer,
          retired_at          = NULL,
          retired_by          = NULL,
          retired_reason      = NULL,
          updated_at          = now()
        WHERE  id                  = v_db_id
          AND  parent_template_id  = p_template_id
          AND  organization_id     = p_organization_id;

        v_local_to_db    := v_local_to_db
                            || jsonb_build_object(v_branch->>'local_id', v_db_id::text);
        v_payload_db_ids := array_append(v_payload_db_ids, v_db_id);
        v_branches_updated := v_branches_updated + 1;

      ELSE
        INSERT INTO public.expense_form_field_option_branches (
          organization_id, parent_template_id, parent_option_value,
          parent_branch_id, field_key, name, field_type, required,
          placeholder, help_text, options, display_order
        ) VALUES (
          p_organization_id,
          p_template_id,
          trim(v_branch->>'parent_option_value'),
          v_parent_db_id,
          trim(v_branch->>'field_key'),
          trim(v_branch->>'name'),
          v_branch->>'field_type',
          (v_branch->>'required')::boolean,
          NULLIF(trim(v_branch->>'placeholder'), ''),
          NULLIF(trim(v_branch->>'help_text'),   ''),
          CASE
            WHEN (v_branch->>'field_type') IN ('select','checkbox')
            THEN v_branch->'options'
            ELSE NULL
          END,
          (v_branch->>'display_order')::integer
        )
        RETURNING id INTO v_new_id;

        v_local_to_db    := v_local_to_db
                            || jsonb_build_object(v_branch->>'local_id', v_new_id::text);
        v_payload_db_ids := array_append(v_payload_db_ids, v_new_id);
        v_branches_inserted := v_branches_inserted + 1;
      END IF;
    END LOOP;
  END LOOP;

  -- ── 10.  Retire active branches absent from the payload ───────────────────
  UPDATE public.expense_form_field_option_branches
  SET
    retired_at     = now(),
    retired_by     = auth.uid(),
    retired_reason = 'removed_from_configuration',
    updated_at     = now()
  WHERE parent_template_id = p_template_id
    AND organization_id    = p_organization_id
    AND retired_at         IS NULL
    AND id                 <> ALL (v_payload_db_ids);

  GET DIAGNOSTICS v_branches_retired = ROW_COUNT;

  -- ── 11.  Atomically update template options + updated_at ──────────────────
  UPDATE public.expense_form_field_templates
  SET
    options    = to_jsonb(v_valid_parent_options),
    updated_at = now()
  WHERE  id              = p_template_id
    AND  organization_id = p_organization_id
  RETURNING updated_at INTO v_current_updated_at;

  -- ── 12.  Write audit row ─────────────────────────────────────────────────
  INSERT INTO public.expense_form_field_branch_config_revisions (
    organization_id, template_id, changed_by, source, reason,
    parent_options_snapshot,
    branches_inserted, branches_updated, branches_retired
  ) VALUES (
    p_organization_id,
    p_template_id,
    auth.uid(),
    p_source,
    p_reason,
    to_jsonb(v_valid_parent_options),
    v_branches_inserted,
    v_branches_updated,
    v_branches_retired
  )
  RETURNING id INTO v_revision_id;

  -- ── 13.  Clear write context ─────────────────────────────────────────────
  PERFORM set_config('app.branch_write_context', '', TRUE);

  RETURN jsonb_build_object(
    'ok',                true,
    'revision_id',       v_revision_id,
    'latest_updated_at', v_current_updated_at,
    'branches_inserted', v_branches_inserted,
    'branches_updated',  v_branches_updated,
    'branches_retired',  v_branches_retired
  );

EXCEPTION WHEN OTHERS THEN
  -- Always clear write context on any error path
  PERFORM set_config('app.branch_write_context', '', TRUE);
  RAISE;
END;
$$;

REVOKE ALL   ON FUNCTION public.save_option_branch_configuration_atomically FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_option_branch_configuration_atomically TO authenticated;

COMMENT ON FUNCTION public.save_option_branch_configuration_atomically IS
  'Atomic branch config save: validates, upserts/retires branches, writes audit row. '
  'Replaces the old browser-side DELETE+INSERT pattern (DOC-047).';
