-- Add attachment_required_above_amount setting (default ₹50)
-- This setting controls when bill attachments become mandatory
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.settings WHERE key = 'attachment_required_above_amount'
  ) THEN
    INSERT INTO public.settings (key, value, description)
    VALUES ('attachment_required_above_amount', '50', 'Amount threshold (in rupees) above which bill attachments become mandatory. Expenses at or below this amount do not require attachments.');
  END IF;
END $$;

