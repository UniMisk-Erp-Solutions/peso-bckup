-- Bulk upsert for backup restore: client upsert on expense_form_field_values hits
-- many RLS policies per row and can exceed statement_timeout on self-hosted Postgres.

CREATE OR REPLACE FUNCTION public.is_org_admin(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = p_org_id
      AND om.role = 'admin'
      AND om.is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_org_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_org_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_restore_upsert_form_field_values(
  p_organization_id uuid,
  p_rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_org_admin(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorized to restore for this organization';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_populate_recordset(null::public.expense_form_field_values, p_rows) AS r
    WHERE r.organization_id IS DISTINCT FROM p_organization_id
  ) THEN
    RAISE EXCEPTION 'organization_id mismatch in restore payload';
  END IF;

  INSERT INTO public.expense_form_field_values AS v (
    id,
    organization_id,
    expense_id,
    template_id,
    branch_field_id,
    field_value,
    created_at,
    updated_at
  )
  SELECT
    r.id,
    r.organization_id,
    r.expense_id,
    r.template_id,
    r.branch_field_id,
    r.field_value,
    COALESCE(r.created_at, now()),
    COALESCE(r.updated_at, now())
  FROM jsonb_populate_recordset(null::public.expense_form_field_values, p_rows) AS r
  ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    expense_id = EXCLUDED.expense_id,
    template_id = EXCLUDED.template_id,
    branch_field_id = EXCLUDED.branch_field_id,
    field_value = EXCLUDED.field_value,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_restore_upsert_form_field_values(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_restore_upsert_form_field_values(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.admin_restore_upsert_form_field_values(uuid, jsonb) IS
  'Org-admin backup restore: bulk upsert expense_form_field_values without per-row RLS overhead.';
