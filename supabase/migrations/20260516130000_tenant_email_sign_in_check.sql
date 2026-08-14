-- Pre-auth check: email may sign in on a tenant subdomain only if user belongs to that org.

CREATE OR REPLACE FUNCTION public.email_can_sign_in_on_tenant(
  p_email text,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    INNER JOIN public.organization_memberships om
      ON om.user_id = p.user_id
      AND om.organization_id = p_organization_id
      AND COALESCE(om.is_active, true) = true
    WHERE lower(trim(p.email)) = lower(trim(p_email))
  );
$$;

GRANT EXECUTE ON FUNCTION public.email_can_sign_in_on_tenant(text, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.email_can_sign_in_on_tenant(text, uuid) IS
  'True when the email belongs to an active member of the given organization (tenant sign-in gate).';
