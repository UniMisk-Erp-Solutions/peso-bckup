-- Archive RPCs: preview (read-only), copy (dry-run default), blocked purge, restore preview, metrics, historical read
-- Requires archive schema from 20260925180000.

BEGIN;

CREATE OR REPLACE FUNCTION archive._caller_is_org_admin_v1(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, archive
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = p_organization_id
      AND om.is_active = true
      AND om.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION archive._table_on_legal_hold_v1(
  p_organization_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = archive
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM archive.archive_legal_holds h
    WHERE h.organization_id = p_organization_id
      AND h.entity_type = p_entity_type
      AND h.entity_id = p_entity_id
      AND h.released_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION archive._assert_table_allowlisted_v1(p_table_name text)
RETURNS archive.archive_policy
LANGUAGE plpgsql
STABLE
SET search_path = archive, public
AS $fn$
DECLARE
  v_pol archive.archive_policy;
BEGIN
  SELECT * INTO v_pol FROM archive.archive_policy ap WHERE ap.table_name = p_table_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'table % is not in archive policy allowlist', p_table_name
      USING ERRCODE = '22023';
  END IF;
  IF v_pol.date_column !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid date_column in policy for %', p_table_name
      USING ERRCODE = '22023';
  END IF;
  RETURN v_pol;
END;
$fn$;

-- READ-ONLY preview (never mutates)
CREATE OR REPLACE FUNCTION public.preview_archive_batch_v1(
  p_table_name        text,
  p_organization_id   uuid,
  p_cutoff_date       timestamptz,
  p_limit             integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, archive
AS $fn$
DECLARE
  v_pol archive.archive_policy;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
  v_eligible bigint := 0;
  v_oldest timestamptz;
  v_newest timestamptz;
  v_legal bigint := 0;
  v_sample uuid[] := '{}';
  v_warnings text[] := ARRAY[]::text[];
  v_status jsonb := '{}'::jsonb;
  v_sql text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL OR p_cutoff_date IS NULL THEN
    RAISE EXCEPTION 'organization_id and cutoff_date are required' USING ERRCODE = '22023';
  END IF;
  IF NOT archive._caller_is_org_admin_v1(p_organization_id) THEN
    RAISE EXCEPTION 'organization admin required' USING ERRCODE = '42501';
  END IF;

  v_pol := archive._assert_table_allowlisted_v1(p_table_name);

  IF NOT v_pol.archive_enabled THEN
    v_warnings := array_append(v_warnings, 'archive_enabled=false for this table (preview only)');
  END IF;

  IF p_table_name = 'expenses' THEN
    SELECT COUNT(*),
           MIN(e.updated_at),
           MAX(e.updated_at)
      INTO v_eligible, v_oldest, v_newest
      FROM public.expenses e
     WHERE e.organization_id = p_organization_id
       AND e.updated_at < p_cutoff_date
       AND (
         NOT v_pol.require_terminal_status
         OR e.status::text = ANY (v_pol.terminal_status_values)
       )
       AND NOT archive._table_on_legal_hold_v1(p_organization_id, 'expense', e.id)
       AND NOT EXISTS (
         SELECT 1 FROM archive.archived_row_store s
         WHERE s.source_table = 'expenses' AND s.source_id = e.id
       );

    SELECT COALESCE(jsonb_object_agg(status::text, cnt), '{}'::jsonb)
      INTO v_status
      FROM (
        SELECT e.status, COUNT(*) AS cnt
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.updated_at < p_cutoff_date
        GROUP BY e.status
      ) x;

    SELECT COALESCE(array_agg(id), '{}')
      INTO v_sample
      FROM (
        SELECT e.id
        FROM public.expenses e
        WHERE e.organization_id = p_organization_id
          AND e.updated_at < p_cutoff_date
          AND (
            NOT v_pol.require_terminal_status
            OR e.status::text = ANY (v_pol.terminal_status_values)
          )
        ORDER BY e.updated_at ASC
        LIMIT 20
      ) s;

    v_warnings := array_append(
      v_warnings,
      'expenses: moving rows requires EFV/attachments/audit_logs cascade plan — not automated'
    );

  ELSIF p_table_name = 'notifications' THEN
    SELECT COUNT(*), MIN(n.created_at), MAX(n.created_at)
      INTO v_eligible, v_oldest, v_newest
      FROM public.notifications n
     WHERE n.created_at < p_cutoff_date
       AND n.read = true
       AND EXISTS (
         SELECT 1 FROM public.organization_memberships om
         WHERE om.user_id = n.user_id
           AND om.organization_id = p_organization_id
           AND om.is_active = true
       )
       AND NOT EXISTS (
         SELECT 1 FROM archive.archived_row_store s
         WHERE s.source_table = 'notifications' AND s.source_id = n.id
       );

  ELSIF p_table_name = 'audit_logs' THEN
    SELECT COUNT(*), MIN(a.created_at), MAX(a.created_at)
      INTO v_eligible, v_oldest, v_newest
      FROM public.audit_logs a
      JOIN public.expenses e ON e.id = a.expense_id
     WHERE e.organization_id = p_organization_id
       AND a.created_at < p_cutoff_date
       AND NOT archive._table_on_legal_hold_v1(p_organization_id, 'expense', a.expense_id)
       AND NOT EXISTS (
         SELECT 1 FROM archive.archived_row_store s
         WHERE s.source_table = 'audit_logs' AND s.source_id = a.id
       );
    v_warnings := array_append(v_warnings, 'audit_logs: compliance review required before copy');

  ELSIF p_table_name = 'generated_reports' THEN
    SELECT COUNT(*), MIN(g.last_generated_at), MAX(g.last_generated_at)
      INTO v_eligible, v_oldest, v_newest
      FROM public.generated_reports g
     WHERE g.organization_id = p_organization_id
       AND g.last_generated_at < p_cutoff_date
       AND (g.expires_at IS NULL OR g.expires_at < now())
       AND NOT EXISTS (
         SELECT 1 FROM archive.archived_row_store s
         WHERE s.source_table = 'generated_reports' AND s.source_id = g.id
       );

  ELSIF p_table_name = 'generated_report_runs' THEN
    SELECT COUNT(*), MIN(r.generated_at), MAX(r.generated_at)
      INTO v_eligible, v_oldest, v_newest
      FROM public.generated_report_runs r
     WHERE r.organization_id = p_organization_id
       AND r.generated_at < p_cutoff_date
       AND NOT EXISTS (
         SELECT 1 FROM archive.archived_row_store s
         WHERE s.source_table = 'generated_report_runs' AND s.source_id = r.id
       );

  ELSIF p_table_name = 'report_export_jobs' THEN
    IF to_regclass('public.report_export_jobs') IS NULL THEN
      RAISE EXCEPTION 'public.report_export_jobs does not exist on this database'
        USING ERRCODE = '42P01';
    END IF;
    v_sql := format(
      $q$
      SELECT COUNT(*), MIN(j.created_at), MAX(j.created_at)
        FROM public.report_export_jobs j
       WHERE j.organization_id = $1
         AND j.created_at < $2
         AND j.status = ANY ($3)
      $q$
    );
    EXECUTE v_sql INTO v_eligible, v_oldest, v_newest
      USING p_organization_id, p_cutoff_date, v_pol.terminal_status_values;

  ELSE
    RAISE EXCEPTION 'preview not implemented for table % (policy exists only)', p_table_name
      USING ERRCODE = '0A000';
  END IF;

  SELECT COUNT(*) INTO v_legal
  FROM archive.archive_legal_holds h
  WHERE h.organization_id = p_organization_id
    AND h.released_at IS NULL;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'dry_run', true,
    'table_name', p_table_name,
    'organization_id', p_organization_id,
    'cutoff_date', p_cutoff_date,
    'eligible_rows', v_eligible,
    'oldest_date', v_oldest,
    'newest_date', v_newest,
    'estimated_bytes', NULL,
    'dependency_warnings', to_jsonb(v_warnings),
    'fk_warnings', jsonb_build_array(
      'Cross-table FKs are not auto-resolved; see ARCHIVE_CANDIDATE_AUDIT.md'
    ),
    'legal_hold_count', v_legal,
    'status_distribution', v_status,
    'sample_ids', to_jsonb(v_sample),
    'preview_limit', v_limit,
    'archive_enabled', v_pol.archive_enabled
  );
END;
$fn$;

-- Copy batch: defaults to dry-run (no inserts). Requires copy_enabled + archive_enabled + p_execute=true.
CREATE OR REPLACE FUNCTION public.copy_archive_batch_v1(
  p_table_name        text,
  p_organization_id   uuid,
  p_cutoff_date       timestamptz,
  p_limit             integer DEFAULT 500,
  p_execute           boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, archive
AS $fn$
DECLARE
  v_settings archive.archive_settings;
  v_pol archive.archive_policy;
  v_preview jsonb;
  v_batch_id uuid;
  v_copied bigint := 0;
  v_lock boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT archive._caller_is_org_admin_v1(p_organization_id) THEN
    RAISE EXCEPTION 'organization admin required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_settings FROM archive.archive_settings WHERE id = 1;
  v_pol := archive._assert_table_allowlisted_v1(p_table_name);

  v_preview := public.preview_archive_batch_v1(
    p_table_name, p_organization_id, p_cutoff_date, p_limit
  );

  IF NOT p_execute OR v_settings.global_dry_run OR NOT v_settings.copy_enabled OR NOT v_pol.archive_enabled THEN
    RETURN jsonb_build_object(
      'schema_version', 1,
      'dry_run', true,
      'executed', false,
      'reason', CASE
        WHEN NOT p_execute THEN 'p_execute=false (default)'
        WHEN v_settings.global_dry_run THEN 'archive_settings.global_dry_run=true'
        WHEN NOT v_settings.copy_enabled THEN 'archive_settings.copy_enabled=false'
        WHEN NOT v_pol.archive_enabled THEN 'archive_policy.archive_enabled=false'
        ELSE 'unknown'
      END,
      'preview', v_preview
    );
  END IF;

  v_lock := pg_try_advisory_lock(hashtext('pesowise_archive_batch'));
  IF NOT v_lock THEN
    RAISE EXCEPTION 'another archive batch is running' USING ERRCODE = '55P03';
  END IF;

  BEGIN
    INSERT INTO archive.archive_batches (
      table_name, organization_id, cutoff_date, dry_run, status, initiated_by, row_count_expected
    ) VALUES (
      p_table_name,
      p_organization_id,
      p_cutoff_date,
      false,
      'copying',
      auth.uid(),
      (v_preview->>'eligible_rows')::bigint
    )
    RETURNING id INTO v_batch_id;

    IF p_table_name = 'notifications' THEN
      WITH picked AS (
        SELECT n.*
        FROM public.notifications n
        WHERE n.created_at < p_cutoff_date
          AND n.read = true
          AND EXISTS (
            SELECT 1 FROM public.organization_memberships om
            WHERE om.user_id = n.user_id
              AND om.organization_id = p_organization_id
              AND om.is_active = true
          )
        ORDER BY n.created_at ASC
        LIMIT LEAST(p_limit, v_settings.max_rows_per_batch)
      ),
      ins AS (
        INSERT INTO archive.archived_row_store (
          source_table, source_id, organization_id, row_data, batch_id, source_checksum
        )
        SELECT
          'notifications',
          p.id,
          p_organization_id,
          to_jsonb(p),
          v_batch_id,
          md5(to_jsonb(p)::text)
        FROM picked p
        ON CONFLICT (source_table, source_id) DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_copied FROM ins;
    ELSE
      RAISE EXCEPTION 'copy not implemented for % — preview only', p_table_name
        USING ERRCODE = '0A000';
    END IF;

    UPDATE archive.archive_batches
       SET row_count_archived = v_copied,
           status = 'copied',
           completed_at = now()
     WHERE id = v_batch_id;

    PERFORM pg_advisory_unlock(hashtext('pesowise_archive_batch'));

    RETURN jsonb_build_object(
      'schema_version', 1,
      'dry_run', false,
      'executed', true,
      'batch_id', v_batch_id,
      'rows_copied', v_copied,
      'source_purged', false
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(hashtext('pesowise_archive_batch'));
    RAISE;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.purge_verified_archive_batch_v1(
  p_batch_id uuid,
  p_force    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, archive
AS $fn$
DECLARE
  v_settings archive.archive_settings;
BEGIN
  SELECT * INTO v_settings FROM archive.archive_settings WHERE id = 1;
  IF NOT v_settings.purge_enabled OR NOT p_force THEN
    RETURN jsonb_build_object(
      'schema_version', 1,
      'executed', false,
      'reason', 'purge disabled: set archive_settings.purge_enabled and p_force=true after manual approval'
    );
  END IF;
  RAISE EXCEPTION 'purge_verified_archive_batch_v1 is not enabled in this release'
    USING ERRCODE = '0A000';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.preview_restore_archive_batch_v1(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, archive
AS $fn$
DECLARE
  v_batch archive.archive_batches;
  v_count bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_batch FROM archive.archive_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT archive._caller_is_org_admin_v1(v_batch.organization_id) THEN
    RAISE EXCEPTION 'organization admin required' USING ERRCODE = '42501';
  END IF;
  SELECT COUNT(*) INTO v_count
  FROM archive.archived_row_store s
  WHERE s.batch_id = p_batch_id;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'dry_run', true,
    'batch_id', p_batch_id,
    'rows_in_archive', v_count,
    'restore_enabled', (SELECT restore_enabled FROM archive.archive_settings WHERE id = 1),
    'note', 'restore_archive_batch_v1 not auto-run; manual approval required'
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_archive_metrics_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, archive
AS $fn$
DECLARE
  v_archived bigint;
  v_batches jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT archive._caller_is_org_admin_v1(p_organization_id) THEN
    RAISE EXCEPTION 'organization admin required' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_archived
  FROM archive.archived_row_store s
  WHERE s.organization_id = p_organization_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.started_at DESC), '[]'::jsonb)
    INTO v_batches
  FROM (
    SELECT id, table_name, status, dry_run, row_count_archived, started_at, completed_at
    FROM archive.archive_batches
    WHERE organization_id = p_organization_id
    ORDER BY started_at DESC
    LIMIT 20
  ) b;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'organization_id', p_organization_id,
    'archived_rows', v_archived,
    'hot_rows', NULL,
    'bytes_hot', NULL,
    'bytes_archived', NULL,
    'last_batches', v_batches,
    'settings', (SELECT to_jsonb(s) FROM archive.archive_settings s WHERE id = 1)
  );
END;
$fn$;

-- Historical read (explicit UI only; paginated)
CREATE OR REPLACE FUNCTION public.get_archived_expenses_v1(
  p_organization_id uuid,
  p_date_from       timestamptz,
  p_date_to         timestamptz,
  p_page_size       integer DEFAULT 25,
  p_cursor          timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, archive
AS $fn$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 100);
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL OR p_date_from IS NULL OR p_date_to IS NULL THEN
    RAISE EXCEPTION 'organization_id, date_from, date_to required' USING ERRCODE = '22023';
  END IF;
  IF NOT archive._caller_is_org_admin_v1(p_organization_id) THEN
    RAISE EXCEPTION 'organization admin required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row_data ORDER BY archived_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT s.row_data, s.archived_at
    FROM archive.archived_row_store s
    WHERE s.organization_id = p_organization_id
      AND s.source_table = 'expenses'
      AND s.archived_at >= p_date_from
      AND s.archived_at <= p_date_to
      AND (p_cursor IS NULL OR s.archived_at < p_cursor)
    ORDER BY s.archived_at DESC
    LIMIT v_limit
  ) q;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'rows', COALESCE(v_rows, '[]'::jsonb),
    'page_size', v_limit,
    'notice', 'Archived data only — not mixed with hot expense queries'
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.preview_archive_batch_v1(text, uuid, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copy_archive_batch_v1(text, uuid, timestamptz, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_verified_archive_batch_v1(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preview_restore_archive_batch_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_archive_metrics_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_archived_expenses_v1(uuid, timestamptz, timestamptz, integer, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.preview_archive_batch_v1(text, uuid, timestamptz, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.copy_archive_batch_v1(text, uuid, timestamptz, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_verified_archive_batch_v1(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_restore_archive_batch_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_archive_metrics_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_archived_expenses_v1(uuid, timestamptz, timestamptz, integer, timestamptz) TO authenticated;

COMMIT;
