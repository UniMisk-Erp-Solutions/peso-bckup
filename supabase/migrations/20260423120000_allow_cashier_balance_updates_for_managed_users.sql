-- Allow cashiers to update balances for users they are allowed to manage.
-- This supports cashier -> employee and cashier -> engineer transfers.

CREATE OR REPLACE FUNCTION public.cashier_can_manage_engineer(
  cashier_user_id UUID,
  engineer_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cashier_engineer_id UUID;
  cashier_location_id UUID;
BEGIN
  SELECT p.cashier_assigned_engineer_id, p.cashier_assigned_location_id
  INTO cashier_engineer_id, cashier_location_id
  FROM public.profiles p
  WHERE p.user_id = cashier_user_id
  LIMIT 1;

  -- Backward compatibility: if no assignment exists, cashier can manage all engineers.
  IF cashier_engineer_id IS NULL AND cashier_location_id IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Direct assignment mode.
  IF cashier_engineer_id IS NOT NULL AND cashier_engineer_id = engineer_user_id THEN
    RETURN TRUE;
  END IF;

  -- Location assignment mode.
  IF cashier_location_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.engineer_locations el
    WHERE el.engineer_id = engineer_user_id
      AND el.location_id = cashier_location_id
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cashier_can_manage_engineer(UUID, UUID) TO authenticated;

DROP POLICY IF EXISTS "Cashiers can update managed profiles" ON public.profiles;
CREATE POLICY "Cashiers can update managed profiles"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'cashier'
        AND om.is_active = true
    )
    AND (
      -- Cashiers can still update their own profile (e.g., deduction from own balance).
      profiles.user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.organization_memberships target_om
        WHERE target_om.user_id = profiles.user_id
          AND target_om.organization_id = profiles.organization_id
          AND target_om.is_active = true
          AND (
            (target_om.role = 'employee' AND public.cashier_can_manage_employee(auth.uid(), profiles.user_id))
            OR (target_om.role = 'engineer' AND public.cashier_can_manage_engineer(auth.uid(), profiles.user_id))
          )
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'cashier'
        AND om.is_active = true
    )
    AND (
      profiles.user_id = auth.uid()
      OR EXISTS (
        SELECT 1
        FROM public.organization_memberships target_om
        WHERE target_om.user_id = profiles.user_id
          AND target_om.organization_id = profiles.organization_id
          AND target_om.is_active = true
          AND (
            (target_om.role = 'employee' AND public.cashier_can_manage_employee(auth.uid(), profiles.user_id))
            OR (target_om.role = 'engineer' AND public.cashier_can_manage_engineer(auth.uid(), profiles.user_id))
          )
      )
    )
  );
