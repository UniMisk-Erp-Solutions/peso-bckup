-- DOC-165: message Master Admin writes when blocking an organization (org_blocked flag).
-- Shown to the organization's users on the "Organization blocked" screen.
-- Additive and idempotent. The app tolerates this column being absent (it falls back
-- to a default message), but saving a custom message needs it.
-- Existing RLS on public.organizations already governs who can read/update rows:
-- master admin updates it, organization members read their own organization.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS block_message text;

COMMENT ON COLUMN public.organizations.block_message IS
  'Message shown to users of this organization when the org_blocked feature flag is on (max 500 chars enforced in the app).';

-- Reload PostgREST schema cache so the new column is visible to the API.
NOTIFY pgrst, 'reload schema';
