-- Resolve employee_id -> auth email without Edge Functions (callable before login).

CREATE OR REPLACE FUNCTION public.get_employee_auth_email(
  p_organization_id uuid,
  p_employee_id text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_email text;
BEGIN
  IF p_organization_id IS NULL OR p_employee_id IS NULL OR trim(p_employee_id) = '' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(
    (
      SELECT ofe.enabled
      FROM public.organization_features ofe
      WHERE ofe.organization_id = p_organization_id
        AND ofe.feature_key = 'employee_id_login'
      LIMIT 1
    ),
    false
  ) INTO v_enabled;

  IF NOT v_enabled THEN
    RETURN NULL;
  END IF;

  SELECT p.email INTO v_email
  FROM public.profiles p
  WHERE p.organization_id = p_organization_id
    AND lower(trim(p.employee_id)) = lower(trim(p_employee_id))
    AND COALESCE(p.is_active, true) = true
  LIMIT 1;

  RETURN v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_employee_auth_email(uuid, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_employee_auth_email(uuid, text) IS
  'Pre-auth: returns Supabase Auth email for employee_id when employee_id_login is enabled for the org.';
