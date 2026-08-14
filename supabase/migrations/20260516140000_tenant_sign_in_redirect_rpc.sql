-- Resolve tenant subdomain for redirect when user signs in on the wrong org host.

CREATE OR REPLACE FUNCTION public.get_tenant_sign_in_subdomain_for_email(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT x.subdomain
  FROM (
    SELECT o.subdomain, 1 AS priority
    FROM public.profiles p
    INNER JOIN public.organizations o ON o.id = p.organization_id
    WHERE lower(trim(p.email)) = lower(trim(p_email))
      AND o.subdomain IS NOT NULL
      AND trim(o.subdomain) <> ''
    UNION ALL
    SELECT o.subdomain, 2 AS priority
    FROM public.profiles p
    INNER JOIN public.organization_memberships om
      ON om.user_id = p.user_id
      AND COALESCE(om.is_active, true) = true
    INNER JOIN public.organizations o ON o.id = om.organization_id
    WHERE lower(trim(p.email)) = lower(trim(p_email))
      AND o.subdomain IS NOT NULL
      AND trim(o.subdomain) <> ''
  ) x
  ORDER BY x.priority
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_sign_in_subdomain_for_user(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT x.subdomain
  FROM (
    SELECT o.subdomain, 1 AS priority
    FROM public.profiles p
    INNER JOIN public.organizations o ON o.id = p.organization_id
    WHERE p.user_id = p_user_id
      AND o.subdomain IS NOT NULL
      AND trim(o.subdomain) <> ''
    UNION ALL
    SELECT o.subdomain, 2 AS priority
    FROM public.organization_memberships om
    INNER JOIN public.organizations o ON o.id = om.organization_id
    WHERE om.user_id = p_user_id
      AND COALESCE(om.is_active, true) = true
      AND o.subdomain IS NOT NULL
      AND trim(o.subdomain) <> ''
  ) x
  ORDER BY x.priority
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_sign_in_subdomain_for_email(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tenant_sign_in_subdomain_for_user(uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_tenant_sign_in_subdomain_for_email(text) IS
  'Preferred tenant subdomain for sign-in redirect (profile org first, then membership).';
COMMENT ON FUNCTION public.get_tenant_sign_in_subdomain_for_user(uuid) IS
  'Preferred tenant subdomain for sign-in redirect (profile org first, then membership).';
