-- Dev tenant picker + lookup: use slug when subdomain column is empty (common before Master Admin sets subdomain).

CREATE OR REPLACE FUNCTION public.list_organizations_for_dev_login()
RETURNS TABLE (id uuid, name text, slug text, subdomain text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    o.id,
    o.name,
    o.slug,
    lower(trim(COALESCE(NULLIF(trim(o.subdomain), ''), NULLIF(trim(o.slug), '')))) AS subdomain
  FROM public.organizations o
  WHERE COALESCE(NULLIF(trim(o.subdomain), ''), NULLIF(trim(o.slug), '')) IS NOT NULL
  ORDER BY o.name;
$$;

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
  WHERE lower(trim(COALESCE(NULLIF(trim(o.subdomain), ''), NULLIF(trim(o.slug), ''))))
    = lower(trim(p_subdomain))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_by_subdomain(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_organizations_for_dev_login() IS
  'Lists orgs for localhost dev login picker; tenant label is subdomain or slug.';

COMMENT ON FUNCTION public.get_organization_by_subdomain(text) IS
  'Resolves tenant host label against organizations.subdomain or slug fallback.';
