# Contact Form Backend (Tell us about your organization)

The contact form on `/contact` is now connected to Supabase. Submissions are stored in the `contact_leads` table and are visible in the **Master Admin Dashboard** at `/master`.

## SQL: Create the table (Supabase)

If you use Supabase migrations, run:

```bash
# Apply all migrations (includes contact_leads)
supabase db push
```

Or run the migration file manually in the SQL editor:

- **File:** `supabase/migrations/20250220000000_create_contact_leads.sql`

### Manual SQL (run in Supabase SQL Editor if not using migrations)

```sql
-- Contact leads table (form submissions from /contact)
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

-- Public (including anon) can insert; only master admins can read/update/delete
CREATE POLICY "Anyone can submit contact lead" ON public.contact_leads FOR INSERT WITH CHECK (true);
CREATE POLICY "Master admins can view contact leads" ON public.contact_leads FOR SELECT USING (is_master_admin());
CREATE POLICY "Master admins can update contact leads" ON public.contact_leads FOR UPDATE USING (is_master_admin()) WITH CHECK (is_master_admin());
CREATE POLICY "Master admins can delete contact leads" ON public.contact_leads FOR DELETE USING (is_master_admin());

GRANT INSERT ON public.contact_leads TO anon;
GRANT SELECT, UPDATE, DELETE ON public.contact_leads TO authenticated;
```

The function `is_master_admin()` must already exist (from the master admin migration).

## Behaviour

- **Submit:** Anyone (including unauthenticated visitors) can submit the form; data is inserted into `contact_leads` via the Supabase client (anon key).
- **View/Manage:** Only users with master admin role can see and manage leads in the Master Admin Dashboard at `/master`.

## Master Admin Dashboard

- **Route:** `/master` (protected; only `master_admin` role).
- **Contents:** Organizations list, Contact leads (from this form), Storage metrics.
- **Sidebar:** When logged in as master admin, the sidebar shows "Master Dashboard" and "Settings".

Master admin is determined by `profiles.is_master_admin = true` or membership in `master_admin_memberships`. See `supabase/migrations/20250201000000_create_master_admin_system.sql` for setup.
