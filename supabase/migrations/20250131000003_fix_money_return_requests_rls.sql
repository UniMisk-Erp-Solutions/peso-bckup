-- Fix RLS policies for money_return_requests to work with organization_memberships
-- This ensures employees and engineers can create return requests

DROP POLICY IF EXISTS "Employees and engineers can create return requests" ON public.money_return_requests;
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND auth.uid() = requester_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.role IN ('employee', 'engineer')
        AND om.is_active = true
    )
  );

-- Also update the view policy to ensure it works correctly
DROP POLICY IF EXISTS "Users can view their own return requests" ON public.money_return_requests;
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests FOR SELECT
  USING (
    (auth.uid() = requester_id OR auth.uid() = cashier_id)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.is_active = true
    )
  );

-- Update policy for cashiers to approve/reject
DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
    AND auth.uid() = cashier_id
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
  );

