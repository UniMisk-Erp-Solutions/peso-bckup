-- ============================================================================
-- CONTACT LEADS TABLE (Organization / Contact form submissions)
-- ============================================================================
-- Stores submissions from the "Tell us about your organization" form on /contact.
-- Public (anon) can INSERT; only master admins (and optionally service role) can SELECT.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.contact_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  work_email TEXT NOT NULL,
  company TEXT NOT NULL,
  phone TEXT,
  role TEXT,
  team_size TEXT,
  multi_level BOOLEAN DEFAULT false,
  balance BOOLEAN DEFAULT false,
  multi_location BOOLEAN DEFAULT false,
  receipts BOOLEAN DEFAULT false,
  message TEXT,
  consent_privacy BOOLEAN NOT NULL DEFAULT true,
  consent_marketing BOOLEAN DEFAULT false,
  consent_timestamp TIMESTAMPTZ,
  consent_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_leads_created_at ON public.contact_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_leads_work_email ON public.contact_leads(work_email);

ALTER TABLE public.contact_leads ENABLE ROW LEVEL SECURITY;

-- Allow anonymous insert (public contact form)
CREATE POLICY "Anyone can submit contact lead"
  ON public.contact_leads FOR INSERT
  WITH CHECK (true);

-- Only master admins can read contact leads
CREATE POLICY "Master admins can view contact leads"
  ON public.contact_leads FOR SELECT
  USING (is_master_admin());

-- Only master admins can update/delete (e.g. mark as contacted)
CREATE POLICY "Master admins can update contact leads"
  ON public.contact_leads FOR UPDATE
  USING (is_master_admin())
  WITH CHECK (is_master_admin());

CREATE POLICY "Master admins can delete contact leads"
  ON public.contact_leads FOR DELETE
  USING (is_master_admin());

-- Grants: anon can insert (for public form), authenticated can select (RLS limits to master_admin)
GRANT INSERT ON public.contact_leads TO anon;
GRANT SELECT, UPDATE, DELETE ON public.contact_leads TO authenticated;

COMMENT ON TABLE public.contact_leads IS 'Contact form / organization inquiry submissions from the marketing contact page.';
