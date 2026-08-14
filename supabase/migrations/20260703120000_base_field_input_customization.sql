-- Base field input customization: org admins can change the input type of base
-- expense fields (text / number / dropdown) and provide static dropdown options.
-- Gated in-app by the master-admin feature 'allow_base_field_input_customization'.

-- ---------------------------------------------------------------------------
-- 1) Extend organization_expense_form_fields with input_type + options
-- ---------------------------------------------------------------------------
ALTER TABLE public.organization_expense_form_fields
  ADD COLUMN IF NOT EXISTS input_type TEXT NOT NULL DEFAULT 'default'
    CHECK (input_type IN ('default', 'text', 'number', 'dropdown')),
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.organization_expense_form_fields.input_type IS
  'Render control override for the base field. "default" keeps the built-in control.';
COMMENT ON COLUMN public.organization_expense_form_fields.options IS
  'JSON array of string options used when input_type = "dropdown" (numeric strings for amount).';

-- ---------------------------------------------------------------------------
-- 2) Allow recents tracking for base fields (field_kind = 'base')
-- ---------------------------------------------------------------------------
ALTER TABLE public.form_field_option_usage_tracking
  DROP CONSTRAINT IF EXISTS form_field_option_usage_tracking_field_kind_check;

ALTER TABLE public.form_field_option_usage_tracking
  ADD CONSTRAINT form_field_option_usage_tracking_field_kind_check
  CHECK (field_kind IN ('template', 'branch', 'base'));

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
  IF p_field_kind NOT IN ('template', 'branch', 'base') THEN
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

NOTIFY pgrst, 'reload schema';
