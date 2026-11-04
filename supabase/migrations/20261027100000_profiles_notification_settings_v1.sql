-- Console audit 2026-10-16: the app reads and writes public.profiles.notification_settings
-- (Settings page, Notification Settings page) but the column never existed in Production, so
-- every load answered HTTP 400 (PostgREST 42703, undefined column) and every save silently fell
-- back to localStorage. Notification preferences are per-user settings that should follow the
-- account, so the column is added.
--
-- Additive and non-destructive:
--   * jsonb, NOT NULL with a constant default -> existing rows get the default without a rewrite
--   * no backfill, no policy change: the existing "Users can update their own profile" policy
--     already governs who may write it
--   * a CHECK keeps it a JSON object so the app can always read the three flags
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notification_settings jsonb NOT NULL
  DEFAULT '{"popup_enabled": true, "sound_enabled": true, "desktop_enabled": false}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_notification_settings_is_object'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_notification_settings_is_object
      CHECK (jsonb_typeof(notification_settings) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.notification_settings IS
  'Per-user notification preferences: {popup_enabled, sound_enabled, desktop_enabled}. Written by the user through their own profile row.';

NOTIFY pgrst, 'reload schema';
