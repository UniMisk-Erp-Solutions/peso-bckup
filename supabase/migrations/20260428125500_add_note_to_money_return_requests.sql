-- Add optional note on money return requests and carry it into transfer history logs.

ALTER TABLE public.money_return_requests
ADD COLUMN IF NOT EXISTS note TEXT;

COMMENT ON COLUMN public.money_return_requests.note IS
  'Optional note entered by requester while returning money.';

CREATE OR REPLACE FUNCTION public.log_money_return_to_history(
  request_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  request_record RECORD;
  requester_role TEXT;
  transfer_type TEXT;
  transfer_note TEXT;
BEGIN
  SELECT
    mrr.requester_id,
    mrr.cashier_id,
    mrr.amount,
    mrr.organization_id,
    mrr.approved_at,
    mrr.note
  INTO request_record
  FROM public.money_return_requests mrr
  WHERE mrr.id = request_id
    AND mrr.status = 'approved'
    AND mrr.approved_at IS NOT NULL;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT role INTO requester_role
  FROM public.organization_memberships
  WHERE user_id = request_record.requester_id
    AND organization_id = request_record.organization_id
    AND is_active = true
  LIMIT 1;

  IF requester_role = 'employee' THEN
    transfer_type := 'employee_to_cashier';
  ELSIF requester_role = 'engineer' THEN
    transfer_type := 'engineer_to_cashier';
  ELSE
    RETURN;
  END IF;

  transfer_note := format('Money return request approved (%s)', request_id::text);
  IF request_record.note IS NOT NULL AND btrim(request_record.note) <> '' THEN
    transfer_note := transfer_note || ': ' || btrim(request_record.note);
  END IF;

  INSERT INTO public.cash_transfer_history (
    organization_id,
    transferrer_id,
    transferrer_role,
    recipient_id,
    recipient_role,
    amount,
    transfer_type,
    transferred_at,
    notes
  ) VALUES (
    request_record.organization_id,
    request_record.requester_id,
    requester_role,
    request_record.cashier_id,
    'cashier',
    request_record.amount,
    transfer_type,
    request_record.approved_at,
    transfer_note
  )
  ON CONFLICT DO NOTHING;
END;
$$;
