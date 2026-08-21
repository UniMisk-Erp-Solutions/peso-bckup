-- ── PesoWise · HOTFIX: server-side search/pagination/on-demand load
-- ── + option-scoped partial atomic save for Form Field Templates
-- Migration: 20260820200000_form_template_server_pagination.sql
--
-- Incident: the Production Form Field Template editor's V1 loader
-- (loadDraftBranchesForTemplate in src/lib/optionBranchPersistence.ts) does
-- an unbounded `SELECT * ... WHERE organization_id = ... AND
-- parent_template_id = ...` against expense_form_field_option_branches.
-- PostgREST's configured row-response cap (~1,000) silently truncates that
-- result for any template whose active branch count exceeds it -- and the
-- V1 save RPC (save_option_branch_configuration_atomically,
-- 290707_3000_branch_config_atomic_save.sql, UNCHANGED by this migration)
-- retires every active branch NOT present in the browser's payload. A
-- truncated load followed by a save would silently retire real
-- configuration for every option past row ~1,000.
--
-- This migration does not modify V1 in any way -- it adds three narrowly
-- scoped, additive RPCs that replace the "browser owns the entire template
-- snapshot" model:
--   1. search_form_template_parent_options   — server-side search + pagination
--      over a template's options[], returning only cheap per-option
--      aggregates (never branch rows).
--   2. get_form_template_parent_option_configuration — on-demand fetch of
--      exactly ONE parent option's full branch tree (root + all nested
--      descendants, recursive) plus a content fingerprint.
--   3. save_parent_option_branch_configuration_atomically — option-SCOPED
--      atomic save. Every retirement/update candidate is drawn exclusively
--      from that ONE option's own pre-save branch tree (v_existing_ids) —
--      structurally incapable of touching a branch belonging to any other
--      parent option, regardless of payload content.
--
-- Ported from the proven prototype on debug/category-server-search-pagination
-- (20260818120000_debug_category_server_search_pagination_v2.sql, never
-- applied to Production) onto current main. Logic unchanged from the
-- prototype except: this migration's own comments no longer say
-- "prototype"/"debug", and the hardcoded Project Unique ID template UUID
-- below was re-verified against live Production data before this file was
-- finalized (see Documentations MD entry for this hotfix for the exact
-- verification query and result).
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 1 — search_form_template_parent_options
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.search_form_template_parent_options (
  p_organization_id uuid,
  p_template_id     uuid,
  p_query           text    DEFAULT NULL,
  p_page            integer DEFAULT 1,
  p_page_size       integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_page          integer := GREATEST(1, COALESCE(p_page, 1));
  v_page_size     integer := LEAST(100, GREATEST(1, COALESCE(p_page_size, 25)));
  v_query         text    := NULLIF(trim(COALESCE(p_query, '')), '');
  v_required_keys text[]  := ARRAY[]::text[];
  v_results       jsonb;
  v_total         integer := 0;
  v_total_pages   integer;
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates
    WHERE id = p_template_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  -- Required root field_keys for the project-integrity indicator (identical
  -- rule set to save_parent_option_branch_configuration_atomically below —
  -- kept in sync manually since Postgres has no shared-constant mechanism
  -- between functions).
  IF p_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48'::uuid THEN
    v_required_keys := ARRAY['project_id', 'project_name'];
  END IF;

  SELECT v_required_keys || COALESCE(array_agg(DISTINCT elem->>'field_key'), ARRAY[]::text[])
  INTO   v_required_keys
  FROM   public.expense_form_field_branch_presets p,
         jsonb_array_elements(p.field_schema) AS elem
  WHERE  p.organization_id              = p_organization_id
    AND  p.parent_template_id           = p_template_id
    AND  p.is_default                   = true
    AND  p.enforce_on_all_parent_options = true
    AND  (elem->>'required')::boolean   = true;

  SELECT array_agg(DISTINCT k) INTO v_required_keys FROM unnest(v_required_keys) AS k;
  v_required_keys := COALESCE(v_required_keys, ARRAY[]::text[]);

  WITH tmpl_opts AS (
    SELECT opt, ord
    FROM   public.expense_form_field_templates t,
           LATERAL jsonb_array_elements_text(t.options) WITH ORDINALITY AS x(opt, ord)
    WHERE  t.id = p_template_id AND t.organization_id = p_organization_id
  ),
  filtered AS (
    SELECT opt, ord FROM tmpl_opts
    WHERE  v_query IS NULL OR opt ILIKE ('%' || v_query || '%')
  ),
  branch_agg AS (
    SELECT parent_option_value,
           count(*) FILTER (WHERE parent_branch_id IS NULL) AS root_count,
           count(*)                                          AS total_count
    FROM   public.expense_form_field_option_branches
    WHERE  parent_template_id = p_template_id
      AND  organization_id    = p_organization_id
      AND  retired_at         IS NULL
    GROUP BY parent_option_value
  ),
  root_keys AS (
    SELECT parent_option_value, array_agg(DISTINCT field_key) AS keys
    FROM   public.expense_form_field_option_branches
    WHERE  parent_template_id = p_template_id
      AND  organization_id    = p_organization_id
      AND  retired_at         IS NULL
      AND  parent_branch_id   IS NULL
    GROUP BY parent_option_value
  ),
  paged AS (
    SELECT f.opt, f.ord, count(*) OVER () AS total_matching
    FROM   filtered f
    ORDER BY f.ord
    OFFSET (v_page - 1) * v_page_size
    LIMIT  v_page_size
  )
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'option_value',             p.opt,
        'display_index',            p.ord,
        'active_root_branch_count', COALESCE(ba.root_count, 0),
        'active_total_branch_count',COALESCE(ba.total_count, 0),
        'configured',               COALESCE(ba.root_count, 0) > 0,
        'integrity_status',
          CASE
            WHEN array_length(v_required_keys, 1) IS NULL THEN 'not_applicable'
            WHEN rk.keys IS NOT NULL AND rk.keys @> v_required_keys THEN 'complete'
            ELSE 'incomplete'
          END
      )
      ORDER BY p.ord
    ),
    COALESCE(max(p.total_matching), 0)
  INTO   v_results, v_total
  FROM   paged p
  LEFT JOIN branch_agg ba ON ba.parent_option_value = p.opt
  LEFT JOIN root_keys  rk ON rk.parent_option_value = p.opt;

  v_total_pages := GREATEST(1, ceil(v_total::numeric / v_page_size)::integer);

  RETURN jsonb_build_object(
    'results',       COALESCE(v_results, '[]'::jsonb),
    'page',           v_page,
    'page_size',      v_page_size,
    'total_results',  v_total,
    'total_pages',    v_total_pages,
    'has_previous',   v_page > 1,
    'has_next',       v_page < v_total_pages
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.search_form_template_parent_options FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_form_template_parent_options TO authenticated;

COMMENT ON FUNCTION public.search_form_template_parent_options IS
  'DOC-097 hotfix. Server-side search + pagination over a template''s parent '
  'options. Never returns branch definitions — only cheap per-option '
  'aggregates. Admin-only, org-scoped, page_size clamped to [1,100].';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 2 — get_form_template_parent_option_configuration
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_form_template_parent_option_configuration (
  p_organization_id     uuid,
  p_template_id         uuid,
  p_parent_option_value text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branches    jsonb;
  v_fingerprint text;
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates
    WHERE id = p_template_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  WITH RECURSIVE option_branches AS (
    SELECT * FROM public.expense_form_field_option_branches
    WHERE  parent_template_id  = p_template_id
      AND  organization_id     = p_organization_id
      AND  parent_option_value = p_parent_option_value
      AND  parent_branch_id    IS NULL
      AND  retired_at          IS NULL
    UNION ALL
    SELECT b.* FROM public.expense_form_field_option_branches b
    JOIN   option_branches ob ON b.parent_branch_id = ob.id
    WHERE  b.retired_at IS NULL
  )
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'db_id',               id,
        'parent_branch_id',    parent_branch_id,
        'parent_option_value', parent_option_value,
        'field_key',           field_key,
        'name',                name,
        'field_type',          field_type,
        'required',            required,
        'placeholder',         placeholder,
        'help_text',           help_text,
        'options',             options,
        'display_order',       display_order
      )
      ORDER BY display_order
    ),
    md5(COALESCE(
      string_agg(id::text || ':' || extract(epoch FROM updated_at)::text, ',' ORDER BY id),
      ''
    ))
  INTO v_branches, v_fingerprint
  FROM option_branches;

  RETURN jsonb_build_object(
    'parent_option_value',        p_parent_option_value,
    'branches',                   COALESCE(v_branches, '[]'::jsonb),
    'configuration_fingerprint',  v_fingerprint
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.get_form_template_parent_option_configuration FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_form_template_parent_option_configuration TO authenticated;

COMMENT ON FUNCTION public.get_form_template_parent_option_configuration IS
  'DOC-097 hotfix. Fetches ONE parent option''s full branch tree (root + '
  'nested descendants, recursive CTE) plus a content fingerprint for '
  'optimistic concurrency on the option-scoped save. Never downloads any '
  'other option''s branches.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 3 — save_parent_option_branch_configuration_atomically
--
-- The core safety property: every mutation is scoped to v_existing_ids,
-- computed ONCE at the top of the function as "this option's own pre-save
-- branch tree". Retirement candidates and every UPDATE's extra WHERE-clause
-- guard are drawn exclusively from that set — there is no code path that
-- can reference, retire, update, or otherwise touch a branch belonging to
-- any OTHER parent option of this template.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_parent_option_branch_configuration_atomically (
  p_organization_id      uuid,
  p_template_id          uuid,
  p_parent_option_value  text,
  p_expected_fingerprint text,
  p_branches             jsonb,
  p_source               text DEFAULT 'category_management_v2',
  p_reason                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_fingerprint text;
  v_existing_ids        uuid[];
  v_option_exists       boolean;
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
  v_required_keys        text[]  := ARRAY[]::text[];
  v_missing              text[];
BEGIN
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

  PERFORM 1 FROM public.expense_form_field_templates
  WHERE id = p_template_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates t,
      jsonb_array_elements_text(t.options) AS opt
    WHERE t.id = p_template_id AND t.organization_id = p_organization_id
      AND opt = p_parent_option_value
  ) INTO v_option_exists;

  IF NOT v_option_exists THEN
    RAISE EXCEPTION 'Parent option "%" is not an active option on this template',
      p_parent_option_value;
  END IF;

  WITH RECURSIVE option_branches AS (
    SELECT id, updated_at FROM public.expense_form_field_option_branches
    WHERE  parent_template_id  = p_template_id
      AND  organization_id     = p_organization_id
      AND  parent_option_value = p_parent_option_value
      AND  parent_branch_id    IS NULL
      AND  retired_at          IS NULL
    UNION ALL
    SELECT b.id, b.updated_at FROM public.expense_form_field_option_branches b
    JOIN   option_branches ob ON b.parent_branch_id = ob.id
    WHERE  b.retired_at IS NULL
  )
  SELECT array_agg(id),
         md5(COALESCE(string_agg(id::text || ':' || extract(epoch FROM updated_at)::text, ',' ORDER BY id), ''))
  INTO   v_existing_ids, v_current_fingerprint
  FROM   option_branches;
  v_existing_ids := COALESCE(v_existing_ids, ARRAY[]::uuid[]);

  IF p_expected_fingerprint IS NOT NULL AND v_current_fingerprint <> p_expected_fingerprint THEN
    RAISE EXCEPTION
      'stale_option_configuration: Parent option "%" was modified by another session. '
      'Reload it to see the latest.', p_parent_option_value
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_branch IN SELECT value FROM jsonb_array_elements(p_branches) LOOP
    IF coalesce(trim(v_branch->>'name'), '') = '' THEN
      RAISE EXCEPTION 'Branch name cannot be empty (local_id=%)', v_branch->>'local_id';
    END IF;
    IF coalesce(trim(v_branch->>'field_key'), '') = '' THEN
      RAISE EXCEPTION 'Branch field_key cannot be empty (local_id=%)', v_branch->>'local_id';
    END IF;
    IF (v_branch->>'field_type') NOT IN
         ('text','number','date','textarea','select','checkbox') THEN
      RAISE EXCEPTION 'Invalid field_type "%" (local_id=%)',
        v_branch->>'field_type', v_branch->>'local_id';
    END IF;
    IF (v_branch->>'parent_local_id') IS NULL
       AND (v_branch->>'parent_option_value') <> p_parent_option_value THEN
      RAISE EXCEPTION
        'Root branch parent_option_value "%" does not match the option being saved ("%")',
        v_branch->>'parent_option_value', p_parent_option_value;
    END IF;
    IF (v_branch->>'db_id') IS NOT NULL
       AND NOT (nullif(v_branch->>'db_id', '')::uuid = ANY (v_existing_ids)) THEN
      RAISE EXCEPTION
        'Branch db_id % does not belong to parent option "%" — refusing to touch another option''s row',
        v_branch->>'db_id', p_parent_option_value;
    END IF;
  END LOOP;

  IF p_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48'::uuid THEN
    v_required_keys := ARRAY['project_id', 'project_name'];
  END IF;

  SELECT v_required_keys || COALESCE(array_agg(DISTINCT elem->>'field_key'), ARRAY[]::text[])
  INTO   v_required_keys
  FROM   public.expense_form_field_branch_presets p,
         jsonb_array_elements(p.field_schema) AS elem
  WHERE  p.organization_id              = p_organization_id
    AND  p.parent_template_id           = p_template_id
    AND  p.is_default                   = true
    AND  p.enforce_on_all_parent_options = true
    AND  (elem->>'required')::boolean   = true;

  SELECT array_agg(DISTINCT k) INTO v_required_keys FROM unnest(v_required_keys) AS k;
  v_required_keys := COALESCE(v_required_keys, ARRAY[]::text[]);

  IF array_length(v_required_keys, 1) IS NOT NULL THEN
    SELECT array_agg(rk) INTO v_missing
    FROM   unnest(v_required_keys) AS rk
    WHERE  NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_branches) AS b
      WHERE  (b.value->>'parent_local_id') IS NULL
        AND  b.value->>'field_key' = rk
    );
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION
        'project_integrity: Parent option "%" is missing required field(s): %',
        p_parent_option_value, array_to_string(v_missing, ', ')
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM set_config('app.branch_write_context',
                     'save_parent_option_branch_configuration_atomically', TRUE);

  FOR v_branch IN
    SELECT value FROM jsonb_array_elements(p_branches)
    WHERE  (value->>'parent_local_id') IS NULL
  LOOP
    v_db_id := nullif(v_branch->>'db_id', '')::uuid;

    IF v_db_id IS NOT NULL THEN
      UPDATE public.expense_form_field_option_branches
      SET
        field_key      = trim(v_branch->>'field_key'),
        name           = trim(v_branch->>'name'),
        field_type     = v_branch->>'field_type',
        required       = (v_branch->>'required')::boolean,
        placeholder    = NULLIF(trim(v_branch->>'placeholder'), ''),
        help_text      = NULLIF(trim(v_branch->>'help_text'),   ''),
        options        = CASE
                            WHEN (v_branch->>'field_type') IN ('select','checkbox')
                            THEN v_branch->'options'
                            ELSE NULL
                          END,
        display_order  = (v_branch->>'display_order')::integer,
        retired_at     = NULL,
        retired_by     = NULL,
        retired_reason = NULL,
        updated_at     = now()
      WHERE id = v_db_id
        AND parent_template_id  = p_template_id
        AND organization_id     = p_organization_id
        AND parent_option_value = p_parent_option_value
        AND id = ANY (v_existing_ids);

      v_local_to_db    := v_local_to_db || jsonb_build_object(v_branch->>'local_id', v_db_id::text);
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
        p_parent_option_value,
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

      v_local_to_db    := v_local_to_db || jsonb_build_object(v_branch->>'local_id', v_new_id::text);
      v_payload_db_ids := array_append(v_payload_db_ids, v_new_id);
      v_branches_inserted := v_branches_inserted + 1;
    END IF;
  END LOOP;

  LOOP
    SELECT count(*) INTO v_remaining_count
    FROM   jsonb_array_elements(p_branches)
    WHERE  (value->>'parent_local_id') IS NOT NULL
      AND  NOT (v_local_to_db ? (value->>'local_id'));

    EXIT WHEN v_remaining_count = 0;
    EXIT WHEN v_remaining_count = v_prev_remaining;
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
          name                 = trim(v_branch->>'name'),
          field_type           = v_branch->>'field_type',
          required             = (v_branch->>'required')::boolean,
          placeholder          = NULLIF(trim(v_branch->>'placeholder'), ''),
          help_text            = NULLIF(trim(v_branch->>'help_text'),   ''),
          options              = CASE
                                    WHEN (v_branch->>'field_type') IN ('select','checkbox')
                                    THEN v_branch->'options'
                                    ELSE NULL
                                  END,
          display_order        = (v_branch->>'display_order')::integer,
          retired_at           = NULL,
          retired_by           = NULL,
          retired_reason       = NULL,
          updated_at           = now()
        WHERE id = v_db_id
          AND parent_template_id = p_template_id
          AND organization_id    = p_organization_id
          AND id = ANY (v_existing_ids);

        v_local_to_db    := v_local_to_db || jsonb_build_object(v_branch->>'local_id', v_db_id::text);
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

        v_local_to_db    := v_local_to_db || jsonb_build_object(v_branch->>'local_id', v_new_id::text);
        v_payload_db_ids := array_append(v_payload_db_ids, v_new_id);
        v_branches_inserted := v_branches_inserted + 1;
      END IF;
    END LOOP;
  END LOOP;

  UPDATE public.expense_form_field_option_branches
  SET
    retired_at     = now(),
    retired_by     = auth.uid(),
    retired_reason = 'removed_from_configuration',
    updated_at     = now()
  WHERE id = ANY (v_existing_ids)
    AND retired_at IS NULL
    AND id <> ALL (v_payload_db_ids);

  GET DIAGNOSTICS v_branches_retired = ROW_COUNT;

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
    jsonb_build_array(p_parent_option_value),
    v_branches_inserted,
    v_branches_updated,
    v_branches_retired
  )
  RETURNING id INTO v_revision_id;

  PERFORM set_config('app.branch_write_context', '', TRUE);

  RETURN jsonb_build_object(
    'ok',                  true,
    'revision_id',         v_revision_id,
    'parent_option_value', p_parent_option_value,
    'branches_inserted',   v_branches_inserted,
    'branches_updated',    v_branches_updated,
    'branches_retired',    v_branches_retired
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.branch_write_context', '', TRUE);
  RAISE;
END;
$$;

REVOKE ALL   ON FUNCTION public.save_parent_option_branch_configuration_atomically FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_parent_option_branch_configuration_atomically TO authenticated;

COMMENT ON FUNCTION public.save_parent_option_branch_configuration_atomically IS
  'DOC-097 hotfix. Option-SCOPED atomic branch save. Structurally cannot '
  'retire/update/insert a branch belonging to any parent option other than '
  'p_parent_option_value — see v_existing_ids scoping throughout. Does NOT '
  'replace or modify V1 (save_option_branch_configuration_atomically), '
  'which remains available and is still used for brand-new (unsaved) '
  'templates.';

NOTIFY pgrst, 'reload schema';
