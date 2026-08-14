-- Minimal org list for localhost dev tenant picker on the login page (subdomain labels only).

CREATE OR REPLACE FUNCTION public.list_organizations_for_dev_login()
RETURNS TABLE (id uuid, name text, slug text, subdomain text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.slug, o.subdomain
  FROM public.organizations o
  WHERE o.subdomain IS NOT NULL
    AND length(trim(o.subdomain)) > 0
  ORDER BY o.name;
$$;

GRANT EXECUTE ON FUNCTION public.list_organizations_for_dev_login() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.list_organizations_for_dev_login() IS
  'Lists tenant hosts (subdomain) for localhost dev login picker; UI is localhost-only.';
