-- Feature-flag propagation: broadcast organization_features changes over
-- Realtime so an already-open client tab sees a Master Admin toggle without
-- waiting for the next page load or the auth-context cache's 5-minute
-- refresh window (owner QA fix pass, 2026-09-23 -- see AuthContext.tsx's new
-- organization_features subscription and refreshOrganizationFeatureFlags).
--
-- Purely additive at the replication layer: no table, column, RLS policy or
-- grant changes. RLS already allows an active member (or master admin) to
-- SELECT their own organization's rows (organization_features_select), so
-- adding this table to the publication cannot expose anything a client
-- couldn't already read via a normal query -- Realtime's postgres_changes
-- still enforces RLS per subscriber.
--
-- Idempotent: ALTER PUBLICATION ... ADD TABLE fails if the table is already
-- a member, so this is guarded to be safely re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'organization_features'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.organization_features;
  END IF;
END;
$$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'organization_features'
  ) THEN
    RAISE EXCEPTION 'organization_features was not added to the supabase_realtime publication';
  END IF;
  RAISE NOTICE 'organization_features_realtime migration verified OK';
END;
$verify$;
