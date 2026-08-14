-- Public RPCs for tenant subdomain and pre-auth feature checks.

CREATE OR REPLACE FUNCTION public.get_organization_by_subdomain(p_subdomain text)
RETURNS TABLE (id uuid, name text, slug text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.name, o.slug
  FROM public.organizations o
  WHERE o.subdomain IS NOT NULL
    AND length(trim(o.subdomain)) > 0
    AND lower(trim(o.subdomain)) = lower(trim(p_subdomain))
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_by_subdomain(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_organization_by_subdomain(text) IS 'Returns org id/name/slug for a tenant subdomain label; used before login.';

CREATE OR REPLACE FUNCTION public.get_organization_feature_enabled(
  p_organization_id uuid,
  p_feature_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT ofe.enabled
      FROM public.organization_features ofe
      WHERE ofe.organization_id = p_organization_id
        AND ofe.feature_key = p_feature_key
      LIMIT 1
    ),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_organization_feature_enabled(uuid, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_organization_feature_enabled(uuid, text) IS 'Whether a feature is enabled for an org; safe for pre-auth tenant login UI.';
