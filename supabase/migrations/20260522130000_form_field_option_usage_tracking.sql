-- Track custom dropdown / select option usage per user (top-3 recommendations like categories).

CREATE TABLE IF NOT EXISTS public.form_field_option_usage_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  field_key text NOT NULL,
  field_kind text NOT NULL CHECK (field_kind IN ('template', 'branch')),
  option_value text NOT NULL,
  usage_count integer NOT NULL DEFAULT 1,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, field_key, field_kind, option_value)
);

COMMENT ON TABLE public.form_field_option_usage_tracking IS
  'Per-user usage counts for custom form select options and conditional dropdown branches.';

CREATE INDEX IF NOT EXISTS idx_form_field_option_usage_user
  ON public.form_field_option_usage_tracking (user_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_form_field_option_usage_field
  ON public.form_field_option_usage_tracking (field_key, field_kind, organization_id);

ALTER TABLE public.form_field_option_usage_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own form field option usage" ON public.form_field_option_usage_tracking;
CREATE POLICY "Users can view own form field option usage"
  ON public.form_field_option_usage_tracking FOR SELECT
  USING (
    user_id = auth.uid()
    AND organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can insert own form field option usage" ON public.form_field_option_usage_tracking;
CREATE POLICY "Users can insert own form field option usage"
  ON public.form_field_option_usage_tracking FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can update own form field option usage" ON public.form_field_option_usage_tracking;
CREATE POLICY "Users can update own form field option usage"
  ON public.form_field_option_usage_tracking FOR UPDATE
  USING (
    user_id = auth.uid()
    AND organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE OR REPLACE FUNCTION public.increment_form_field_option_usage(
  p_organization_id uuid,
  p_user_id uuid,
  p_field_key text,
  p_field_kind text,
  p_option_value text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_field_kind NOT IN ('template', 'branch') THEN
    RAISE EXCEPTION 'invalid field_kind';
  END IF;
  IF length(trim(coalesce(p_option_value, ''))) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.form_field_option_usage_tracking (
    organization_id,
    user_id,
    field_key,
    field_kind,
    option_value,
    usage_count,
    last_used_at
  )
  VALUES (
    p_organization_id,
    p_user_id,
    p_field_key,
    p_field_kind,
    trim(p_option_value),
    1,
    now()
  )
  ON CONFLICT (organization_id, user_id, field_key, field_kind, option_value)
  DO UPDATE SET
    usage_count = form_field_option_usage_tracking.usage_count + 1,
    last_used_at = now(),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_form_field_option_usage(uuid, uuid, text, text, text) TO authenticated;

DROP TRIGGER IF EXISTS update_form_field_option_usage_updated_at ON public.form_field_option_usage_tracking;
CREATE TRIGGER update_form_field_option_usage_updated_at
  BEFORE UPDATE ON public.form_field_option_usage_tracking
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
