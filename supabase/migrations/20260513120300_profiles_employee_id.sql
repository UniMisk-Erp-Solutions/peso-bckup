-- Optional employee id per profile (unique per organization when set).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS employee_id text;

COMMENT ON COLUMN public.profiles.employee_id IS 'Optional employee login id; unique per organization when employee_id_login feature is on.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'organization_id'
  ) THEN
    DROP INDEX IF EXISTS idx_profiles_organization_employee_id_unique;
    EXECUTE $idx$
      CREATE UNIQUE INDEX idx_profiles_organization_employee_id_unique
      ON public.profiles (organization_id, employee_id)
      WHERE employee_id IS NOT NULL
        AND trim(employee_id) <> ''
        AND organization_id IS NOT NULL
    $idx$;
  END IF;
END $$;
