-- DOC-099 — Financial path closure pass. New additive migration; nothing
-- prior is edited in place.
--
-- Two small shared SQL helpers, factored out so cashier-scope authorization
-- and legacy cash_transfer_history role normalization each have exactly ONE
-- implementation, consumed by every canonical money-moving RPC (manual add,
-- transfer-offer accept, and the new money-return approval). Prevents the
-- "UI direct Add has one authorization rule, transfer offers have another"
-- drift the independent audit flagged.

-- ---------------------------------------------------------------------------
-- public._cashier_target_authorized_v1
--
-- Reproduces Balances.tsx's own cashier-scope precedence (location first,
-- then direct-engineer fallback, then unrestricted for a cashier with
-- neither assignment -- documented current-Production backward compatibility,
-- not a new decision). Already inlined once in balance_add_funds_v1
-- (20260819172000); this is that same logic, extracted so
-- propose_balance_transfer_offer can use the identical rule instead of its
-- own narrower engineer-only copy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._cashier_target_authorized_v1(
  p_cashier_user_id uuid,
  p_org_id          uuid,
  p_target_user_id  uuid,
  p_target_role     text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cashier_assigned_engineer_id uuid;
  v_cashier_assigned_location_id uuid;
  v_target_reporting_engineer_id uuid;
BEGIN
  SELECT p.cashier_assigned_engineer_id, p.cashier_assigned_location_id
  INTO v_cashier_assigned_engineer_id, v_cashier_assigned_location_id
  FROM public.profiles p WHERE p.user_id = p_cashier_user_id;

  IF v_cashier_assigned_location_id IS NOT NULL THEN
    IF p_target_role = 'engineer' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.engineer_locations el
        JOIN public.organization_memberships om
          ON om.user_id = el.engineer_id AND om.organization_id = p_org_id AND om.is_active = true
        WHERE el.location_id = v_cashier_assigned_location_id
          AND el.engineer_id = p_target_user_id
      );
    ELSIF p_target_role = 'employee' THEN
      SELECT p.reporting_engineer_id INTO v_target_reporting_engineer_id
      FROM public.profiles p WHERE p.user_id = p_target_user_id;

      RETURN v_target_reporting_engineer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.engineer_locations el
        JOIN public.organization_memberships om
          ON om.user_id = el.engineer_id AND om.organization_id = p_org_id AND om.is_active = true
        WHERE el.location_id = v_cashier_assigned_location_id
          AND el.engineer_id = v_target_reporting_engineer_id
      );
    ELSE
      -- team_leader / executive / any other non-admin non-cashier role: the
      -- audited location scope only covers employee/engineer targets, matching
      -- 20260819172000's own scope. Not further restricted here.
      RETURN true;
    END IF;
  ELSIF v_cashier_assigned_engineer_id IS NOT NULL THEN
    IF p_target_role = 'employee' THEN
      SELECT p.reporting_engineer_id INTO v_target_reporting_engineer_id
      FROM public.profiles p WHERE p.user_id = p_target_user_id;
      RETURN v_target_reporting_engineer_id IS NOT DISTINCT FROM v_cashier_assigned_engineer_id;
    ELSIF p_target_role = 'engineer' THEN
      RETURN p_target_user_id IS NOT DISTINCT FROM v_cashier_assigned_engineer_id;
    ELSE
      RETURN true;
    END IF;
  ELSE
    -- Neither assignment: unrestricted, matching Balances.tsx's documented
    -- backward-compatible behavior for an unassigned cashier.
    RETURN true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._cashier_target_authorized_v1(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._cashier_target_authorized_v1(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public._cashier_target_authorized_v1(uuid, uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- public._legacy_transfer_history_role_v1
--
-- cash_transfer_history.recipient_role's CHECK constraint
-- (20250129000000_create_cash_transfer_history.sql) only allows
-- ('admin','cashier','engineer','employee') -- it predates the team_leader /
-- executive roles. The transfer-offer acceptance RPC already normalizes
-- team_leader/executive -> employee before writing that legacy table
-- (080608_1430_balance_transfer_offers.sql); balance_add_funds_v1 did not,
-- which is the root cause of the "exe" (role='executive')
-- cash_transfer_history_recipient_role_check violation observed during the
-- prior QA pass. This does NOT change organization_memberships.role -- only
-- the legacy history table's representation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._legacy_transfer_history_role_v1(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_role IN ('team_leader', 'executive') THEN 'employee' ELSE p_role END;
$$;

REVOKE ALL ON FUNCTION public._legacy_transfer_history_role_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._legacy_transfer_history_role_v1(text) FROM anon;
GRANT EXECUTE ON FUNCTION public._legacy_transfer_history_role_v1(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
