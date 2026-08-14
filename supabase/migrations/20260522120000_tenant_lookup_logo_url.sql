-- Include logo_url in pre-auth tenant subdomain lookup (sign-in branding).
-- Must drop first: PostgreSQL cannot change OUT/return row type via CREATE OR REPLACE.

DROP FUNCTION IF EXISTS public.get_organization_by_subdomain(text);

CREATE FUNCTION public.get_organization_by_subdomain(p_subdomain text)
RETURNS TABLE (id uuid, name text, slug text, logo_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.slug, o.logo_url
  FROM public.organizations o
  WHERE o.subdomain IS NOT NULL
    AND length(trim(o.subdomain)) > 0
    AND lower(trim(o.subdomain)) = lower(trim(p_subdomain))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_by_subdomain(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_organization_by_subdomain(text) IS
  'Returns org id/name/slug/logo_url for a tenant subdomain label; used before login.';
