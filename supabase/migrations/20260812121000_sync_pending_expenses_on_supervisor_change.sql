-- Debug branch debug/6456-supervisor-auth-runtime — future-proof companion to
-- 20260812120000_fix_pending_expense_supervisor_reassignment.sql.
--
-- That migration made verification authority dynamic (current
-- reporting_engineer_id, not just the snapshot) so an already-stale
-- assignment can still be verified. This migration prevents NEW staleness:
-- whenever an employee's immediate supervisor changes, their still-pending,
-- never-yet-verified expenses are reassigned to the CURRENT supervisor in
-- the SAME transaction as the profile update — automatically, regardless of
-- which application code path performs the update (User Management UI, a
-- future bulk import, another admin tool, a direct SQL script). This is
-- deliberately a database-level trigger, not only a frontend fix, because a
-- frontend-only mechanism can be bypassed by any other write path.
--
-- Scope (read the WHEN clause and function body together):
--   * fires only when reporting_engineer_id actually changes (WHEN clause;
--     the function body never runs for unrelated profile edits);
--   * scoped to NEW.organization_id + NEW.user_id only — no cross-org or
--     cross-employee reach;
--   * touches only expenses with status IN ('submitted','edited',
--     'under_review') AND approval_tier IS NULL OR IN ('team_leader',
--     'executive') — i.e. never yet verified at any hierarchy tier. Rows at
--     level_1_verified/level_2_verified or any terminal status
--     (verified/approved/rejected/paid) are never touched, so completed
--     history and later-tier work are never rewound or rewritten;
--   * new reporting_engineer_id = NULL: the function returns without
--     touching any expense — existing assignments are left exactly as they
--     are rather than being nulled out or reassigned to a guessed fallback;
--   * writes one audit_logs row per reassigned expense (required —
--     audit_logs.expense_id is NOT NULL and its RLS policies join back
--     through it) so the change is traceable on that expense's own history;
--     for a normal individual supervisor change this is a handful of rows,
--     not a notification storm — existing application code paths are the
--     only thing that sends notifications, and this trigger never touches
--     expenses.status, so none of the existing status-triggered
--     notification/activity triggers fire either. The separate one-time
--     bulk repair (companion migration, applied once) deliberately does
--     NOT use audit_logs for exactly this reason — see that migration;
--   * cannot recurse: it writes to `expenses` and `audit_logs`, never back
--     to `profiles`, so it cannot re-trigger itself.
--
-- Verified against live Production schema (read-only) before writing this:
-- the two existing BEFORE UPDATE triggers on `expenses`
-- (check_engineer_approval_limit, assign_transaction_number) both gate on
-- NEW.status transitions this UPDATE never causes (status is not part of
-- the SET list), so they are no-ops here; the two status/amount-conditioned
-- AFTER triggers (trg_user_activity_expense_submitted,
-- trigger_update_org_activity_on_expense_update) do not fire either, for
-- the same reason.
--
-- Read-only for anyone who does not modify `profiles.reporting_engineer_id`
-- — this migration performs no data mutation itself.

CREATE OR REPLACE FUNCTION public.sync_pending_expenses_on_supervisor_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), NEW.user_id);
BEGIN
  IF NEW.reporting_engineer_id IS NULL THEN
    -- "Do not invent a supervisor": leave existing pending assignments as-is
    -- rather than nulling them out or guessing a fallback reviewer.
    RETURN NEW;
  END IF;

  -- audit_logs.expense_id is NOT NULL and its RLS policies join back through
  -- expenses.id, so one row per reassigned expense (not one per-employee
  -- summary row) is both required and the more useful trail — anyone who
  -- could already see that expense sees why its reviewer changed.
  WITH moved AS (
    UPDATE public.expenses e
    SET assigned_reviewer_id = NEW.reporting_engineer_id,
        assigned_engineer_id = NEW.reporting_engineer_id,
        updated_at = now()
    WHERE e.user_id = NEW.user_id
      AND e.organization_id = NEW.organization_id
      AND e.status IN ('submitted', 'edited', 'under_review')
      AND (e.approval_tier IS NULL OR e.approval_tier IN ('team_leader', 'executive'))
      AND (
        e.assigned_reviewer_id IS DISTINCT FROM NEW.reporting_engineer_id
        OR e.assigned_engineer_id IS DISTINCT FROM NEW.reporting_engineer_id
      )
    RETURNING e.id
  )
  INSERT INTO public.audit_logs (expense_id, user_id, action, comment, organization_id)
  SELECT m.id, v_actor, 'reviewer_reassigned',
    format(
      'Pending reviewer reassigned — employee''s immediate supervisor changed (old=%s, new=%s).',
      COALESCE(OLD.reporting_engineer_id::text, 'none'),
      NEW.reporting_engineer_id::text
    ),
    NEW.organization_id
  FROM moved m;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.sync_pending_expenses_on_supervisor_change() IS
  'Trigger target for profiles AFTER UPDATE OF reporting_engineer_id. Reassigns the employee''s still-pending, never-yet-verified immediate-supervisor-stage expenses to the new supervisor. Not intended for direct invocation.';

-- Trigger-only helper — no direct caller, so no EXECUTE grant to
-- authenticated/anon/PUBLIC. Revoke the default PUBLIC grant a bare CREATE
-- FUNCTION would otherwise leave in place.
REVOKE ALL ON FUNCTION public.sync_pending_expenses_on_supervisor_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_pending_expenses_on_supervisor_change ON public.profiles;

CREATE TRIGGER trg_sync_pending_expenses_on_supervisor_change
  AFTER UPDATE OF reporting_engineer_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.reporting_engineer_id IS DISTINCT FROM NEW.reporting_engineer_id)
  EXECUTE FUNCTION public.sync_pending_expenses_on_supervisor_change();
