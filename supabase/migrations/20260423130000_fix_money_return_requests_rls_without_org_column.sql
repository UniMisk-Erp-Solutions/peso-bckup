-- Fix money_return_requests RLS without requiring organization_id column.
-- Uses organization_memberships to validate org/role relationships.

DROP POLICY IF EXISTS "Employees and engineers can create return requests" ON public.money_return_requests;
DROP POLICY IF EXISTS "Users can view their own return requests" ON public.money_return_requests;
DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;

-- Requesters can create return requests only when:
-- 1) they are the authenticated user
-- 2) they are employee/engineer in an active org membership
-- 3) cashier_id belongs to an active cashier/admin in the same org
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests
  FOR INSERT
  WITH CHECK (
    auth.uid() = requester_id
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships req_om
      JOIN public.organization_memberships cash_om
        ON cash_om.organization_id = req_om.organization_id
       AND cash_om.user_id = money_return_requests.cashier_id
       AND cash_om.is_active = true
       AND cash_om.role IN ('cashier', 'admin')
      WHERE req_om.user_id = auth.uid()
        AND req_om.is_active = true
        AND req_om.role IN ('employee', 'engineer')
    )
  );

-- Requester or cashier can view a request if both participants are in at least
-- one common active organization membership.
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests
  FOR SELECT
  USING (
    (auth.uid() = requester_id OR auth.uid() = cashier_id)
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships req_om
      JOIN public.organization_memberships cash_om
        ON cash_om.organization_id = req_om.organization_id
       AND cash_om.user_id = money_return_requests.cashier_id
       AND cash_om.is_active = true
      WHERE req_om.user_id = money_return_requests.requester_id
        AND req_om.is_active = true
    )
  );

-- Assigned cashier (or admin acting as cashier) can approve/reject updates only
-- when they share an active organization with requester.
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests
  FOR UPDATE
  USING (
    auth.uid() = cashier_id
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships actor_om
      JOIN public.organization_memberships req_om
        ON req_om.organization_id = actor_om.organization_id
       AND req_om.user_id = money_return_requests.requester_id
       AND req_om.is_active = true
      WHERE actor_om.user_id = auth.uid()
        AND actor_om.is_active = true
        AND actor_om.role IN ('cashier', 'admin')
    )
  )
  WITH CHECK (
    auth.uid() = cashier_id
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships actor_om
      JOIN public.organization_memberships req_om
        ON req_om.organization_id = actor_om.organization_id
       AND req_om.user_id = money_return_requests.requester_id
       AND req_om.is_active = true
      WHERE actor_om.user_id = auth.uid()
        AND actor_om.is_active = true
        AND actor_om.role IN ('cashier', 'admin')
    )
  );
