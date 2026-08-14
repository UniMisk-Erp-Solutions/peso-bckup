-- Create settings table for system-wide configuration
CREATE TABLE IF NOT EXISTS public.settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- Only admins can view settings
CREATE POLICY "Admins can view settings"
  ON public.settings FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- Only admins can update settings
CREATE POLICY "Admins can update settings"
  ON public.settings FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- Only admins can insert settings
CREATE POLICY "Admins can insert settings"
  ON public.settings FOR INSERT
  USING (public.has_role(auth.uid(), 'admin'));

-- Insert default engineer approval limit (50000 = ₹50,000)
INSERT INTO public.settings (key, value, description)
VALUES ('engineer_approval_limit', '50000', 'Maximum amount (in rupees) that engineers can approve directly. Expenses below this limit can be approved by engineers, above this limit must go to admin.')
ON CONFLICT (key) DO NOTHING;

