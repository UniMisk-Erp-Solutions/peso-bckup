-- Per-user UI language preference (en | hi | gu).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_preferred_language_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_preferred_language_check
      CHECK (preferred_language IN ('en', 'hi', 'gu'));
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.preferred_language IS 'UI language: en (default), hi, gu.';
