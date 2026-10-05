-- Security fix — a real, confirmed gap found by this pass's active-member
-- authorization audit (task item 37/38): `reject_balance_transfer_offer`
-- and `cancel_balance_transfer_offer` (both defined in
-- `080608_1430_balance_transfer_offers.sql`, still live, still the only
-- version, still directly called by the frontend, `GRANT EXECUTE TO
-- authenticated` never revoked) perform NO query against
-- `organization_memberships` at all -- authorization is solely
-- `auth.uid() = offer.recipient_id` / `offer.transferrer_id` plus row
-- status. A user whose `organization_memberships.is_active` has been
-- flipped to false (deactivated) but who still holds an unexpired JWT
-- could reject a transfer offer addressed to them, or cancel one they
-- sent, with no server-side re-check.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- Surgical fix only: the SAME two functions, SAME signatures, SAME
-- behavior in every other respect (same error messages, same status
-- transitions) -- one additional check inserted, matching the EXACT clause
-- shape already used everywhere else in this codebase (e.g.
-- `accept_balance_transfer_offer_v2` in the same original file) rather
-- than inventing a new pattern.
--
-- Per the audit's own explicit finding: this is the ONLY gap in the
-- checked categories (expense create/edit/approve/reject, backup/restore
-- request, user management are all ALREADY correctly protected via
-- `organization_memberships.is_active` or `is_org_admin`) -- this
-- migration deliberately does NOT touch any of those already-correct
-- functions.
--
-- OWNERSHIP NOTE (found while proving this fix): both live functions are
-- owned by `supabase_admin`, not `postgres` -- `CREATE OR REPLACE` from
-- the `postgres` role (the role this repo's own SSH/psql proof scripts
-- connect as) fails with "must be owner of function". This migration's
-- logic was verified correct via an identically-bodied differently-named
-- function (see the rolled-back proof referenced in this pass's report),
-- not by literally replacing the live function in this session. When
-- actually applying this migration, run it as `supabase_admin` (the same
-- role this repo's own scheduled-maintenance scripts already use, e.g.
-- `scripts/expire-backup-jobs.sh`'s `psql -U supabase_admin`), or as
-- whatever role originally owns these functions.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_balance_transfer_offer(
  p_offer_id UUID,
  p_reason TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  offer public.balance_transfer_offers%ROWTYPE;
  v_reason TEXT := trim(coalesce(p_reason, ''));
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Rejection reason must be at least 3 characters';
  END IF;

  SELECT * INTO offer
  FROM public.balance_transfer_offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer offer not found';
  END IF;

  IF offer.status <> 'pending' THEN
    RAISE EXCEPTION 'Transfer offer is no longer pending';
  END IF;

  IF offer.recipient_id <> v_caller THEN
    RAISE EXCEPTION 'Only the recipient can reject this offer';
  END IF;

  -- NEW: the fix. Same clause shape already used throughout this codebase
  -- (e.g. accept_balance_transfer_offer_v2's own recipient-side check).
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_caller AND om.organization_id = offer.organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'You are no longer an active member of this organization';
  END IF;

  UPDATE public.balance_transfer_offers
  SET
    status = 'rejected',
    rejection_reason = v_reason,
    responded_at = NOW(),
    responded_by = v_caller,
    updated_at = NOW()
  WHERE id = offer.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_balance_transfer_offer(p_offer_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  offer public.balance_transfer_offers%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO offer
  FROM public.balance_transfer_offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer offer not found';
  END IF;

  IF offer.status <> 'pending' THEN
    RAISE EXCEPTION 'Only pending offers can be cancelled';
  END IF;

  IF offer.transferrer_id <> v_caller THEN
    RAISE EXCEPTION 'Only the sender can cancel this offer';
  END IF;

  -- NEW: the fix.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_caller AND om.organization_id = offer.organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'You are no longer an active member of this organization';
  END IF;

  UPDATE public.balance_transfer_offers
  SET
    status = 'cancelled',
    responded_at = NOW(),
    responded_by = v_caller,
    updated_at = NOW()
  WHERE id = offer.id;
END;
$$;

-- Grants unchanged (already GRANT EXECUTE TO authenticated, never revoked
-- for these two functions) -- CREATE OR REPLACE preserves existing grants
-- in Postgres, but the checks below confirm that explicitly rather than
-- assuming it.
DO $verify$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.reject_balance_transfer_offer(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must retain EXECUTE on reject_balance_transfer_offer';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.cancel_balance_transfer_offer(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must retain EXECUTE on cancel_balance_transfer_offer';
  END IF;
  RAISE NOTICE 'balance_transfer_offer_active_membership_check migration verified OK';
END;
$verify$;
