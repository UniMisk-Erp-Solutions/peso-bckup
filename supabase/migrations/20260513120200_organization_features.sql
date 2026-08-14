-- Per-organization feature toggles. RLS adapts to your schema (memberships vs profiles column names).

CREATE TABLE IF NOT EXISTS public.organization_features (
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (organization_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_organization_features_org ON public.organization_features (organization_id);

COMMENT ON TABLE public.organization_features IS 'Feature flags per organization; managed by master admin. Keys: src/lib/organizationFeatureKeys.ts';

ALTER TABLE public.organization_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organization_features_select" ON public.organization_features;
DROP POLICY IF EXISTS "organization_features_all_master" ON public.organization_features;

-- SELECT: master admin sees all; org members see their org (detection below).
DO $$
DECLARE
  has_memberships boolean;
  has_profiles boolean;
  prof_auth_col text;
  has_org_id_on_profiles boolean;
  stmt text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_memberships'
  ) INTO has_memberships;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) INTO has_profiles;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'organization_id'
  ) INTO has_org_id_on_profiles;

  IF has_memberships THEN
    EXECUTE $p$
      CREATE POLICY "organization_features_select"
      ON public.organization_features FOR SELECT
      USING (
        public.is_master_admin()
        OR EXISTS (
          SELECT 1
          FROM public.organization_memberships m
          WHERE m.user_id = auth.uid()
            AND COALESCE(m.is_active, true) = true
            AND m.organization_id = organization_features.organization_id
        )
      )
    $p$;
  ELSIF has_profiles AND has_org_id_on_profiles THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'user_id'
    ) THEN
      prof_auth_col := 'user_id';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'id'
    ) THEN
      prof_auth_col := 'id';
    ELSE
      prof_auth_col := NULL;
    END IF;

    IF prof_auth_col IS NOT NULL THEN
      stmt := format(
        'CREATE POLICY "organization_features_select" ON public.organization_features FOR SELECT USING (
          public.is_master_admin()
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.%I = auth.uid()
              AND p.organization_id IS NOT NULL
              AND p.organization_id = organization_features.organization_id
          )
        )',
        prof_auth_col
      );
      EXECUTE stmt;
    ELSE
      EXECUTE $p$
        CREATE POLICY "organization_features_select"
        ON public.organization_features FOR SELECT
        USING (public.is_master_admin())
      $p$;
    END IF;
  ELSE
    EXECUTE $p$
      CREATE POLICY "organization_features_select"
      ON public.organization_features FOR SELECT
      USING (public.is_master_admin())
    $p$;
  END IF;
END $$;

CREATE POLICY "organization_features_all_master"
  ON public.organization_features FOR ALL
  USING (public.is_master_admin())
  WITH CHECK (public.is_master_admin());

GRANT SELECT ON public.organization_features TO authenticated;
GRANT ALL ON public.organization_features TO service_role;
