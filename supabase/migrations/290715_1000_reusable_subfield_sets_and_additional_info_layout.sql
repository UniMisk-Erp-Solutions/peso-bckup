-- ── PesoWise · DOC-062: Reusable Sub-field Sets & Additional Information Layout ─
-- Migration: 290715_1000_reusable_subfield_sets_and_additional_info_layout.sql
-- Purpose  : 1. Create expense_form_field_branch_presets — admin-managed named
--               presets of reusable branch field definitions that can be enforced
--               across all parent options of a template.
--            2. Create organization_expense_field_layout_items — per-org config
--               controlling which fields are visible and in what order on the
--               expense review / detail views.
--            3. Extend save_option_branch_configuration_atomically with a generic
--               preset-driven completeness check (step 6b), keeping the existing
--               hardcoded Project UUID check for backward compatibility.
--
-- ⚠  Apply only after the matching frontend changes are deployed.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE 1: public.expense_form_field_branch_presets
-- Stores named, versioned sets of branch field definitions that an admin can
-- attach to a template.  When enforce_on_all_parent_options = true and
-- is_default = true the atomic-save RPC enforces the preset's required fields
-- across every parent option value.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.expense_form_field_branch_presets (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  parent_template_id          uuid        NOT NULL
    REFERENCES public.expense_form_field_templates (id) ON DELETE CASCADE,
  name                        text        NOT NULL CHECK (length(trim(name)) > 0),
  description                 text,
  schema_version              integer     NOT NULL DEFAULT 1,
  -- JSON array of field definition objects; root-level items with required=true
  -- are enforced when enforce_on_all_parent_options = true.
  field_schema                jsonb       NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(field_schema) = 'array'),
  -- Only one preset per org+template may be default at a time (partial unique
  -- index below enforces this).
  is_default                  boolean     NOT NULL DEFAULT false,
  -- When true AND is_default = true, the atomic-save RPC checks that every
  -- parent option carries all required field_keys from field_schema.
  enforce_on_all_parent_options boolean   NOT NULL DEFAULT false,
  created_by                  uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_by                  uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- Preset names are case-insensitively unique per org+template.
  CONSTRAINT uq_preset_name_per_org_template
    UNIQUE (organization_id, parent_template_id, lower(name))
);

COMMENT ON TABLE public.expense_form_field_branch_presets IS
  'Named, versioned sets of reusable branch field definitions.  '
  'When is_default + enforce_on_all_parent_options are both true, the '
  'save_option_branch_configuration_atomically RPC enforces the preset's '
  'required fields across every parent option. (DOC-062)';

COMMENT ON COLUMN public.expense_form_field_branch_presets.field_schema IS
  'JSON array of field definition objects.  Root-level objects with '
  '"required": true are enforced by the atomic-save RPC when '
  'enforce_on_all_parent_options = true.';

COMMENT ON COLUMN public.expense_form_field_branch_presets.enforce_on_all_parent_options IS
  'When true (and is_default = true), the RPC validates that every parent option '
  'carries all required field_keys from field_schema at the root level.';

-- ── Partial unique index: at most one default preset per org+template ─────────
CREATE UNIQUE INDEX IF NOT EXISTS uix_preset_one_default_per_template
  ON public.expense_form_field_branch_presets (organization_id, parent_template_id)
  WHERE is_default = true;

-- ── Supporting indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_preset_org
  ON public.expense_form_field_branch_presets (organization_id);

CREATE INDEX IF NOT EXISTS idx_preset_template
  ON public.expense_form_field_branch_presets (parent_template_id);

CREATE INDEX IF NOT EXISTS idx_preset_default
  ON public.expense_form_field_branch_presets (organization_id, parent_template_id)
  WHERE is_default = true;

-- ── updated_at trigger ────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS update_expense_form_field_branch_presets_updated_at
  ON public.expense_form_field_branch_presets;
CREATE TRIGGER update_expense_form_field_branch_presets_updated_at
  BEFORE UPDATE ON public.expense_form_field_branch_presets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Row-Level Security ────────────────────────────────────────────────────────
-- Presets are admin-only: org members have no read access (they never need to
-- see raw preset definitions; the RPC enforces them transparently).
ALTER TABLE public.expense_form_field_branch_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins can manage expense_form_field_branch_presets"
  ON public.expense_form_field_branch_presets;
CREATE POLICY "Org admins can manage expense_form_field_branch_presets"
  ON public.expense_form_field_branch_presets
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id         = auth.uid()
        AND organization_id = expense_form_field_branch_presets.organization_id
        AND role            = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id         = auth.uid()
        AND organization_id = expense_form_field_branch_presets.organization_id
        AND role            = 'admin'
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════════
-- TABLE 2: public.organization_expense_field_layout_items
-- Controls the display order and visibility of each field (or sub-field) that
-- appears on the expense review / detail view for a given org and context.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.organization_expense_field_layout_items (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  -- 'review'  — expense list / quick-review panel
  -- 'detail'  — full expense detail / approval page
  context           text        NOT NULL CHECK (context IN ('review', 'detail')),
  parent_template_id uuid       NOT NULL
    REFERENCES public.expense_form_field_templates (id) ON DELETE CASCADE,
  -- Identifies which field this item controls:
  --   'template'            → the parent template field itself
  --   'project_id'          → a root branch field with field_key = 'project_id'
  --   'project_id>site_name'→ nested: root 'project_id' then child 'site_name'
  field_path        text        NOT NULL DEFAULT 'template',
  display_order     integer     NOT NULL DEFAULT 0,
  is_visible        boolean     NOT NULL DEFAULT true,
  -- 'standard' — normal card/row layout
  -- 'compact'  — smaller footprint, label inline
  -- 'inline'   — value rendered inline with adjacent fields
  display_style     text        NOT NULL DEFAULT 'standard'
    CHECK (display_style IN ('standard', 'compact', 'inline')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        REFERENCES auth.users (id) ON DELETE SET NULL,

  -- Each (org, context, template, field_path) combination is unique.
  CONSTRAINT uq_layout_item
    UNIQUE (organization_id, context, parent_template_id, field_path)
);

COMMENT ON TABLE public.organization_expense_field_layout_items IS
  'Per-organisation layout config for expense review and detail views.  '
  'Controls display order, visibility, and style of each template field '
  'or branch sub-field.  (DOC-062)';

COMMENT ON COLUMN public.organization_expense_field_layout_items.field_path IS
  '"template" = the parent template field itself.  '
  '"project_id" = root branch field with that field_key.  '
  '"project_id>site_name" = nested: root key > child key.';

COMMENT ON COLUMN public.organization_expense_field_layout_items.context IS
  '"review" = expense list / quick-review panel.  '
  '"detail" = full expense detail / approval page.';

-- ── Supporting indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_layout_org_context
  ON public.organization_expense_field_layout_items (organization_id, context);

CREATE INDEX IF NOT EXISTS idx_layout_template
  ON public.organization_expense_field_layout_items (parent_template_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS update_organization_expense_field_layout_items_updated_at
  ON public.organization_expense_field_layout_items;
CREATE TRIGGER update_organization_expense_field_layout_items_updated_at
  BEFORE UPDATE ON public.organization_expense_field_layout_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE public.organization_expense_field_layout_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins can manage organization_expense_field_layout_items"
  ON public.organization_expense_field_layout_items;
CREATE POLICY "Org admins can manage organization_expense_field_layout_items"
  ON public.organization_expense_field_layout_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id         = auth.uid()
        AND organization_id = organization_expense_field_layout_items.organization_id
        AND role            = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id         = auth.uid()
        AND organization_id = organization_expense_field_layout_items.organization_id
        AND role            = 'admin'
    )
  );

-- Members need to read layout items to render expense display correctly.
DROP POLICY IF EXISTS "Org members can view organization_expense_field_layout_items"
  ON public.organization_expense_field_layout_items;
CREATE POLICY "Org members can view organization_expense_field_layout_items"
  ON public.organization_expense_field_layout_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id         = auth.uid()
        AND organization_id = organization_expense_field_layout_items.organization_id
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 3: Updated save_option_branch_configuration_atomically RPC
--
-- Adds step 6b — generic preset-driven completeness check — inserted between
-- the existing step 6 (hardcoded Project UUID check) and step 7 (write context).
--
-- The hardcoded UUID check (step 6) is kept unchanged for backward compatibility.
-- Once an enforcing default preset is created for the Project Unique ID template,
-- the generic check (step 6b) supersedes the hardcoded one for new saves.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_option_branch_configuration_atomically (
  p_organization_id     uuid,
  p_template_id         uuid,
  p_expected_updated_at timestamptz,   -- NULL = new template, skip stale check
  p_parent_options      jsonb,         -- jsonb array of option strings
  p_branches            jsonb,         -- jsonb array of branch objects
  p_source              text  DEFAULT 'editor',
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
  -- Step 6b variables
  v_preset_schema        jsonb;
  v_required_field_key   text;
  v_missing_field_key    text;
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

  -- ── 6.  Project-specific completeness check (hardcoded — backward compat) ──
  --    Template 51181324-68cc-4174-bbe0-4834e5e22c48 ("Project Unique ID")
  --    must carry both field_key='project_id' and field_key='project_name'
  --    for every parent option value (root level, parent_local_id IS NULL).
  --
  --    NOTE: Once a preset is created and enforced for this template, the
  --    generic check below (step 6b) supersedes this hardcoded check for
  --    new saves.  This block is kept for backward compatibility with any
  --    save paths that predate the presets feature.
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

  -- ── 6b. Generic preset-driven completeness check ──────────────────────────
  --
  --  If a default preset with enforce_on_all_parent_options = true exists for
  --  this template, every parent option must carry ALL field_keys that are
  --  marked required=true at the root level of the preset's field_schema.
  --
  --  This is the generic successor to the hardcoded project check above and
  --  will fire for ANY template that has an enforcing default preset.
  SELECT field_schema
  INTO   v_preset_schema
  FROM   public.expense_form_field_branch_presets
  WHERE  organization_id              = p_organization_id
    AND  parent_template_id           = p_template_id
    AND  is_default                   = true
    AND  enforce_on_all_parent_options = true
  LIMIT 1;

  IF v_preset_schema IS NOT NULL THEN
    -- Iterate over each root-level required field_key in the preset schema.
    FOR v_required_field_key IN
      SELECT elem->>'field_key'
      FROM   jsonb_array_elements(v_preset_schema) AS elem
      WHERE  (elem->>'required')::boolean = true
        AND  (elem->>'field_key') IS NOT NULL
    LOOP
      -- Every parent option must have this field_key at the root branch level
      -- (parent_local_id IS NULL in the incoming payload).
      SELECT opt INTO v_missing_option
      FROM   unnest(v_valid_parent_options) AS opt
      WHERE  NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_branches) AS b
        WHERE  b.value->>'parent_option_value' = opt
          AND  b.value->>'field_key'            = v_required_field_key
          AND  (b.value->>'parent_local_id')    IS NULL
      )
      LIMIT 1;

      IF v_missing_option IS NOT NULL THEN
        RAISE EXCEPTION
          'preset_integrity: Parent option "%" is missing required field "%"',
          v_missing_option, v_required_field_key
          USING ERRCODE = 'P0003';
      END IF;
    END LOOP;
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

REVOKE ALL    ON FUNCTION public.save_option_branch_configuration_atomically FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.save_option_branch_configuration_atomically TO authenticated;

COMMENT ON FUNCTION public.save_option_branch_configuration_atomically IS
  'Atomic branch config save: validates (incl. generic preset enforcement), '
  'upserts/retires branches, writes audit row.  '
  'Step 6b adds preset-driven completeness checks (DOC-062).  '
  'Replaces the old browser-side DELETE+INSERT pattern (DOC-047).';
