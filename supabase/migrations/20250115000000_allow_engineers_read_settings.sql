-- Allow engineers to read settings (specifically for engineer_approval_limit)
CREATE POLICY "Engineers can view settings"
  ON public.settings FOR SELECT
  USING (public.has_role(auth.uid(), 'engineer'));

-- Also allow all authenticated users to read settings (for system-wide configs)
-- This is safe since settings are read-only for non-admins
CREATE POLICY "Authenticated users can view settings"
  ON public.settings FOR SELECT
  USING (auth.role() = 'authenticated');

