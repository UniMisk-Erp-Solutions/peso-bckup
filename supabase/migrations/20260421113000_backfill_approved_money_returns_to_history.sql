-- Backfill old approved money returns into cash_transfer_history
-- This makes previously approved returns visible in transfer history and reports.

WITH approved_returns AS (
  SELECT
    mrr.id AS request_id,
    mrr.requester_id,
    mrr.cashier_id,
    mrr.amount,
    COALESCE(mrr.approved_at, mrr.requested_at, mrr.created_at, NOW()) AS transferred_at,
    COALESCE(
      NULLIF((to_jsonb(mrr) ->> 'organization_id'), '')::uuid,
      (
        SELECT om.organization_id
        FROM public.organization_memberships om
        WHERE om.user_id = mrr.requester_id
          AND om.is_active = true
        LIMIT 1
      ),
      (
        SELECT p.organization_id
        FROM public.profiles p
        WHERE p.user_id = mrr.requester_id
        LIMIT 1
      )
    ) AS organization_id
  FROM public.money_return_requests mrr
  WHERE mrr.status = 'approved'
),
requester_role AS (
  SELECT
    ar.request_id,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = ar.requester_id
          AND om.organization_id = ar.organization_id
          AND om.role = 'engineer'
          AND om.is_active = true
      ) THEN 'engineer'
      WHEN EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = ar.requester_id
          AND om.organization_id = ar.organization_id
          AND om.role = 'employee'
          AND om.is_active = true
      ) THEN 'employee'
      ELSE NULL
    END AS role
  FROM approved_returns ar
)
INSERT INTO public.cash_transfer_history (
  organization_id,
  transferrer_id,
  transferrer_role,
  recipient_id,
  recipient_role,
  amount,
  transfer_type,
  transferred_at,
  payment_mode,
  notes
)
SELECT
  ar.organization_id,
  ar.requester_id,
  rr.role,
  ar.cashier_id,
  'cashier',
  ar.amount,
  CASE
    WHEN rr.role = 'engineer' THEN 'engineer_to_cashier'
    WHEN rr.role = 'employee' THEN 'employee_to_cashier'
    ELSE NULL
  END,
  ar.transferred_at,
  'cash',
  'Money return request approved (' || ar.request_id || ')'
FROM approved_returns ar
JOIN requester_role rr ON rr.request_id = ar.request_id
WHERE ar.organization_id IS NOT NULL
  AND rr.role IN ('engineer', 'employee')
  AND NOT EXISTS (
    SELECT 1
    FROM public.cash_transfer_history cth
    WHERE cth.organization_id = ar.organization_id
      AND cth.transferrer_id = ar.requester_id
      AND cth.recipient_id = ar.cashier_id
      AND cth.amount = ar.amount
      AND cth.transfer_type = CASE
        WHEN rr.role = 'engineer' THEN 'engineer_to_cashier'
        WHEN rr.role = 'employee' THEN 'employee_to_cashier'
        ELSE NULL
      END
      AND cth.transferred_at = ar.transferred_at
  );
