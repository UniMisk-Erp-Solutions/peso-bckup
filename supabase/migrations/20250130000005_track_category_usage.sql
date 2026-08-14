-- Track category usage for recommended categories feature
-- This table stores how frequently each user uses each category

CREATE TABLE IF NOT EXISTS public.category_usage_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  category_name TEXT NOT NULL,
  usage_count INTEGER DEFAULT 1,
  last_used_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, user_id, category_name)
);

-- Add comment
COMMENT ON TABLE public.category_usage_tracking IS 'Tracks how frequently users use each expense category for recommendations';

-- Add indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_category_usage_user ON public.category_usage_tracking(user_id, organization_id);
CREATE INDEX IF NOT EXISTS idx_category_usage_category ON public.category_usage_tracking(category_name, organization_id);
CREATE INDEX IF NOT EXISTS idx_category_usage_last_used ON public.category_usage_tracking(last_used_at DESC);

-- Enable RLS
ALTER TABLE public.category_usage_tracking ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view their own usage tracking
CREATE POLICY "Users can view their own category usage"
  ON public.category_usage_tracking FOR SELECT
  USING (
    user_id = auth.uid() AND
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- Users can insert/update their own usage tracking
CREATE POLICY "Users can track their own category usage"
  ON public.category_usage_tracking FOR INSERT
  WITH CHECK (
    user_id = auth.uid() AND
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "Users can update their own category usage"
  ON public.category_usage_tracking FOR UPDATE
  USING (
    user_id = auth.uid() AND
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

-- Create function to increment usage count
CREATE OR REPLACE FUNCTION increment_category_usage(
  p_organization_id UUID,
  p_user_id UUID,
  p_category_name TEXT
)
RETURNS void AS $$
BEGIN
  INSERT INTO public.category_usage_tracking (
    organization_id,
    user_id,
    category_name,
    usage_count,
    last_used_at
  )
  VALUES (
    p_organization_id,
    p_user_id,
    p_category_name,
    1,
    now()
  )
  ON CONFLICT (organization_id, user_id, category_name)
  DO UPDATE SET
    usage_count = category_usage_tracking.usage_count + 1,
    last_used_at = now(),
    updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION increment_category_usage(UUID, UUID, TEXT) TO authenticated;

-- Create trigger to update updated_at
CREATE TRIGGER update_category_usage_updated_at
  BEFORE UPDATE ON public.category_usage_tracking
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

