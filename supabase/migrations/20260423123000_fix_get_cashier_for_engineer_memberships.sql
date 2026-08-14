-- Fix cashier lookup to use organization_memberships instead of legacy user_roles.
-- Some environments only maintain roles in organization_memberships, causing
-- get_cashier_for_engineer() to return NULL even when a cashier exists.

CREATE OR REPLACE FUNCTION get_cashier_for_engineer(
  engineer_user_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  cashier_user_id UUID;
  engineer_location_id UUID;
  engineer_organization_id UUID;
BEGIN
  SELECT organization_id INTO engineer_organization_id
  FROM public.profiles
  WHERE user_id = engineer_user_id
  LIMIT 1;

  IF engineer_organization_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT el.location_id INTO engineer_location_id
  FROM public.engineer_locations el
  INNER JOIN public.locations loc ON el.location_id = loc.id
  WHERE el.engineer_id = engineer_user_id
    AND loc.organization_id = engineer_organization_id
  LIMIT 1;

  IF engineer_location_id IS NOT NULL THEN
    SELECT p.user_id INTO cashier_user_id
    FROM public.profiles p
    WHERE p.cashier_assigned_location_id = engineer_location_id
      AND p.organization_id = engineer_organization_id
      AND EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = p.user_id
          AND om.organization_id = engineer_organization_id
          AND om.role = 'cashier'
          AND om.is_active = true
      )
    LIMIT 1;

    IF cashier_user_id IS NOT NULL THEN
      RETURN cashier_user_id;
    END IF;
  END IF;

  SELECT p.user_id INTO cashier_user_id
  FROM public.profiles p
  WHERE p.cashier_assigned_engineer_id = engineer_user_id
    AND p.organization_id = engineer_organization_id
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = p.user_id
        AND om.organization_id = engineer_organization_id
        AND om.role = 'cashier'
        AND om.is_active = true
    )
  LIMIT 1;

  RETURN cashier_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_cashier_for_engineer(UUID) TO authenticated;
