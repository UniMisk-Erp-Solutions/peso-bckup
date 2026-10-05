-- Safety hotfix: an organization must never be left with zero active
-- administrators through normal application behavior. Confirmed absent by
-- reading the live body of deactivate_organization_member (and its callers
-- deactivate_organization_member_undoable / undo_organization_member_
-- deactivation / reactivate_organization_member) during the DOC-096
-- Milestone 1C recovery review: self-deactivation is already blocked, but
-- Admin A could freely deactivate Admin B even when B is the org's last
-- active admin, silently stripping the organization of all admin access.
--
-- This is the second, independent invariant alongside self-deactivation --
-- both must hold:
--   A. a user cannot deactivate their own membership (unchanged, pre-existing)
--   B. a user cannot deactivate the org's last remaining active admin (new)
--
-- Placed inside deactivate_organization_member itself so every wrapper that
-- delegates to it (deactivate_organization_member_undoable) inherits the
-- guard automatically -- no wrapper reimplements this logic.
--
-- Concurrency: two admins concurrently deactivating two different admin
-- memberships in the same 2-admin organization must not both succeed --
-- that would leave zero active admins even though each request's own
-- SELECT COUNT(*) saw "2 admins" before either committed. A pg_advisory_xact_lock
-- keyed on the organization id -- the same pattern already used elsewhere in
-- this codebase for other invariant-serialization needs (e.g.
-- archive_expense_category_undoable's idempotency-key lock) -- fully
-- serializes deactivation attempts within one organization for the
-- duration of the transaction, so the second concurrent call always
-- re-reads a post-commit-accurate admin count rather than racing on a
-- stale snapshot.
--
-- Pure function-body change. No rows are read or written by installing
-- this migration; only future deactivate_organization_member calls are
-- affected.

CREATE OR REPLACE FUNCTION public.deactivate_organization_member(p_organization_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_target_role public.app_role;
  v_other_active_admins integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = auth.uid()
      AND om.role = 'admin'
      AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'Only organization admins can deactivate members';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id AND om.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'User is not a member of this organization';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot deactivate your own account';
  END IF;

  -- Serialize every deactivation attempt against this organization for the
  -- rest of this transaction. Without this, two concurrent requests
  -- targeting two different admins in a 2-admin org could each read
  -- "2 active admins" (correct at read time) before either commits, and
  -- both proceed -- leaving the organization with zero active admins even
  -- though each individual check appeared safe in isolation.
  PERFORM pg_advisory_xact_lock(hashtext(p_organization_id::text)::bigint);

  SELECT om.role INTO v_target_role
  FROM public.organization_memberships om
  WHERE om.organization_id = p_organization_id AND om.user_id = p_user_id;

  IF v_target_role = 'admin' THEN
    SELECT count(*) INTO v_other_active_admins
    FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.role = 'admin'
      AND om.is_active = true
      AND om.user_id <> p_user_id;

    IF v_other_active_admins = 0 THEN
      RAISE EXCEPTION 'An organization must have at least one active administrator.';
    END IF;
  END IF;

  -- Clear live routing pointers (other profiles that named this user as
  -- their supervisor/cashier/engineer). deactivate_organization_member_
  -- undoable captures these values before calling this function, so the
  -- immediate Undo can restore them conflict-safely.
  UPDATE public.profiles
  SET
    reporting_engineer_id = CASE WHEN reporting_engineer_id = p_user_id THEN NULL ELSE reporting_engineer_id END,
    assigned_cashier_id = CASE WHEN assigned_cashier_id = p_user_id THEN NULL ELSE assigned_cashier_id END,
    cashier_assigned_engineer_id = CASE WHEN cashier_assigned_engineer_id = p_user_id THEN NULL ELSE cashier_assigned_engineer_id END,
    updated_at = now()
  WHERE organization_id = p_organization_id
    AND (reporting_engineer_id = p_user_id OR assigned_cashier_id = p_user_id OR cashier_assigned_engineer_id = p_user_id);

  UPDATE public.expenses
  SET
    assigned_engineer_id = CASE WHEN assigned_engineer_id = p_user_id THEN NULL ELSE assigned_engineer_id END,
    assigned_reviewer_id = CASE WHEN assigned_reviewer_id = p_user_id THEN NULL ELSE assigned_reviewer_id END,
    updated_at = now()
  WHERE organization_id = p_organization_id
    AND (assigned_engineer_id = p_user_id OR assigned_reviewer_id = p_user_id);

  -- DOC-096 correction: engineer_locations / team_members /
  -- expense_submission_drafts / notifications are deliberately NOT deleted
  -- here anymore -- deactivation is not deletion, and none of these four
  -- tables function as live expense-routing input (see migration header).

  UPDATE public.organization_memberships
  SET is_active = false
  WHERE organization_id = p_organization_id AND user_id = p_user_id;

  UPDATE public.profiles
  SET is_active = false, deactivated_at = now(), updated_at = now()
  WHERE user_id = p_user_id AND organization_id = p_organization_id;
END;
$function$;
