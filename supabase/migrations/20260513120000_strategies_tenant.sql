-- Reference strategies for per-organization product branching (master admin assigns strategy_slug on organizations).

CREATE TABLE IF NOT EXISTS public.strategies (
  slug text PRIMARY KEY,
  label text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now() NOT NULL
);

INSERT INTO public.strategies (slug, label, description) VALUES
  ('standard', 'Standard', 'Default product behavior'),
  ('microlink_v1', 'MicroLink v1', 'MicroLink tenant customizations')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "strategies_select_authenticated" ON public.strategies;
CREATE POLICY "strategies_select_authenticated"
  ON public.strategies FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON public.strategies TO authenticated, anon;
