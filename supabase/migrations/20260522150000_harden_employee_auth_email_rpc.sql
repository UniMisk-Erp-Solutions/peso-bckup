-- Harden pre-auth employee ID → email lookup: rate limits + audit log (anon grant kept for tenant login).

CREATE TABLE IF NOT EXISTS public.employee_auth_lookup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  lookup_key text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_auth_lookup_attempts_org_key_time_idx
  ON public.employee_auth_lookup_attempts (organization_id, lookup_key, attempted_at DESC);

CREATE INDEX IF NOT EXISTS employee_auth_lookup_attempts_org_time_idx
  ON public.employee_auth_lookup_attempts (organization_id, attempted_at DESC);

ALTER TABLE public.employee_auth_lookup_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.employee_auth_lookup_attempts IS
  'Rate-limit log for get_employee_auth_email; no client policies (SECURITY DEFINER only).';

CREATE OR REPLACE FUNCTION public.get_employee_auth_email(
  p_organization_id uuid,
  p_employee_id text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_enabled boolean;
  v_email text;
  v_rate_key text;
  v_per_id_count integer;
  v_per_org_count integer;
  v_max_per_id constant integer := 8;
  v_max_per_org constant integer := 60;
  v_window constant interval := interval '15 minutes';
BEGIN
  IF p_organization_id IS NULL OR p_employee_id IS NULL OR trim(p_employee_id) = '' THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id
  ) THEN
    RETURN NULL;
  END IF;

  v_rate_key := lower(trim(p_employee_id));

  SELECT count(*)::integer INTO v_per_id_count
  FROM public.employee_auth_lookup_attempts a
  WHERE a.organization_id = p_organization_id
    AND a.lookup_key = v_rate_key
    AND a.attempted_at > now() - v_window;

  IF v_per_id_count >= v_max_per_id THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer INTO v_per_org_count
  FROM public.employee_auth_lookup_attempts a
  WHERE a.organization_id = p_organization_id
    AND a.attempted_at > now() - v_window;

  IF v_per_org_count >= v_max_per_org THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.employee_auth_lookup_attempts (organization_id, lookup_key)
  VALUES (p_organization_id, v_rate_key);

  DELETE FROM public.employee_auth_lookup_attempts
  WHERE attempted_at < now() - interval '7 days';

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
    AND lower(trim(p.employee_id)) = v_rate_key
    AND COALESCE(p.is_active, true) = true
  LIMIT 1;

  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION public.get_employee_auth_email(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_employee_auth_email(uuid, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_employee_auth_email(uuid, text) IS
  'Pre-auth: returns auth email for employee_id when employee_id_login is enabled. Rate-limited; returns NULL when limited or not found.';
