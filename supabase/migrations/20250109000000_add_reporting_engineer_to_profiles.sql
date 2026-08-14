-- Add reporting engineer mapping on user profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS reporting_engineer_id UUID REFERENCES auth.users(id);

-- Helpful index for lookups by engineer
CREATE INDEX IF NOT EXISTS idx_profiles_reporting_engineer
  ON public.profiles(reporting_engineer_id);

-- Admins can update profiles already (including this column) via existing policies
-- Optionally allow engineers to view who they manage (not required for core flow)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'Engineers can view managed profiles'
  ) THEN
    CREATE POLICY "Engineers can view managed profiles"
      ON public.profiles FOR SELECT
      USING (
        reporting_engineer_id = auth.uid()
      );
  END IF;
END $$;


