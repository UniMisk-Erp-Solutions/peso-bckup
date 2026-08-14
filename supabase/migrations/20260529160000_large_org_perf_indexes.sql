-- Speed up large-org profile/membership lookups and notification queries.

CREATE INDEX IF NOT EXISTS idx_profiles_organization_id
  ON public.profiles (organization_id);

CREATE INDEX IF NOT EXISTS idx_org_memberships_org_active
  ON public.organization_memberships (organization_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_notifications_user_org_read
  ON public.notifications (user_id, organization_id, read);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);
