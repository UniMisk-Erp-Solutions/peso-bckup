-- Debug branch debug/6456-supervisor-auth-runtime — Issue 1: "supervisor
-- changed after Level 1 was already verified".
--
-- FOLLOW-UP to 20260812121000_sync_pending_expenses_on_supervisor_change.sql.
-- That trigger deliberately covers only never-yet-verified pending rows
-- (status IN submitted/edited/under_review, approval_tier IS NULL/team_leader/
-- executive) and explicitly excludes level_1_verified/level_2_verified — to
-- avoid rewriting completed hierarchy history. That exclusion was correct and
-- stays correct. But it left a real gap: if a Team Leader completes Level 1,
-- and the employee's immediate supervisor (and therefore the hierarchy above
-- them) is changed AFTERWARDS, the expense is now waiting at Level 2 —
-- assigned_reviewer_id/assigned_engineer_id still point at the OLD
-- hierarchy's executive (snapshotted at the moment Level 1 completed), and
-- nothing ever re-points them at the CURRENT executive. The new supervisor's
-- reports see "No eligible expenses selected" because
-- expense_hierarchy_reviewer_can_act's assignment-snapshot branch no longer
-- matches anyone real, and (unlike the pre-verification case) the
-- current-supervisor fallback added in 20260812120000 only fires for
-- status IN (submitted, edited, under_review) — level_1_verified/
-- level_2_verified are deliberately excluded there too, for the same
-- don't-touch-history reason. Same shape of bug, one hierarchy tier later.
--
-- INVARIANT: completed stages are historical; pending stages are dynamic.
--   * status/approval_tier/who-verified/when/comment for a COMPLETED tier
--     are never touched by this trigger — Level 1's audit_logs row, and the
--     level_1_verified status itself, remain exactly as they were.
--   * ONLY the assignment for the CURRENTLY PENDING next stage
--     (assigned_reviewer_id/assigned_engineer_id) is re-pointed at the
--     CURRENT hierarchy — mirroring, in SQL, the same priority rules
--     src/lib/approvalHierarchy.ts already uses for a live verify action
--     (resolveExecutiveReviewerId for the team_leader -> executive edge,
--     resolveReviewerForTier('engineer', ...) for the executive -> engineer
--     edge): prefer the employee's new immediate supervisor if their role
--     already matches the needed tier; else look one hop further up that
--     supervisor's own reporting line; else fall back to the employee's team
--     configuration (teams.executive_user_id / teams.manager_user_id); never
--     invent a reviewer if none of that resolves.
--
-- SCOPE:
--   * level_1_verified rows whose approval_tier is 'executive' (i.e.
--     genuinely still waiting for Level 2) get assigned_reviewer_id /
--     assigned_engineer_id re-pointed at the CURRENT correct executive.
--   * level_2_verified rows whose approval_tier is 'engineer' (waiting for
--     the manager/engineer stage) get them re-pointed at the CURRENT correct
--     engineer/manager.
--   * status itself is NEVER written by this trigger, at any tier.
--   * self-review stays impossible: a resolved candidate equal to the
--     expense's own submitter is discarded, same as every other authority
--     check in this codebase.
--   * only active, correctly-roled organization_memberships rows are ever
--     used as a candidate — an inactive or wrong-role membership is treated
--     as "no candidate" and the next fallback in the priority chain is tried.
--   * cross-org reach is impossible — every lookup is scoped to
--     NEW.organization_id.
--   * idempotent — the WHERE clause only ever matches rows whose current
--     assignment is provably stale (IS DISTINCT FROM the freshly computed
--     value), so re-running produces zero rows once caught up.
--
-- The original never-yet-verified block (status IN submitted/edited/
-- under_review) is reproduced verbatim below, unchanged, so this migration
-- fully replaces (and is a strict superset of) 20260812121000's trigger
-- function body.

CREATE OR REPLACE FUNCTION public.sync_pending_expenses_on_supervisor_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), NEW.user_id);
  v_new_supervisor_role text;
  v_team RECORD;
  v_new_executive uuid;
  v_new_engineer uuid;
BEGIN
  IF NEW.reporting_engineer_id IS NULL THEN
    -- "Do not invent a supervisor": leave existing pending assignments as-is
    -- rather than nulling them out or guessing a fallback reviewer.
    RETURN NEW;
  END IF;

  -- ── Block 1: never-yet-verified pending rows (unchanged from 20260812121000) ──
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

  -- ── Shared lookups for the two NEW blocks below ──────────────────────────
  SELECT om.role INTO v_new_supervisor_role
  FROM public.organization_memberships om
  WHERE om.user_id = NEW.reporting_engineer_id
    AND om.organization_id = NEW.organization_id
    AND om.is_active = true;

  SELECT t.* INTO v_team
  FROM public.team_members tm
  JOIN public.teams t
    ON t.id = tm.team_id
   AND t.organization_id = tm.organization_id
  WHERE tm.user_id = NEW.user_id
    AND tm.organization_id = NEW.organization_id
  LIMIT 1;

  -- ── Block 2: level_1_verified, waiting at Level 2 (executive) ───────────
  -- Mirrors resolveExecutiveReviewerId's priority for the "who is the
  -- executive above this employee's current chain" question: the new
  -- immediate supervisor if they already are the executive; else that
  -- supervisor's own supervisor if THEY are the executive (the
  -- team_leader -> executive edge); else the team's configured executive.
  v_new_executive := CASE
    WHEN v_new_supervisor_role = 'executive' THEN NEW.reporting_engineer_id
    WHEN v_new_supervisor_role = 'team_leader' THEN (
      SELECT sup.reporting_engineer_id
      FROM public.profiles sup
      JOIN public.organization_memberships som
        ON som.user_id = sup.reporting_engineer_id
       AND som.organization_id = NEW.organization_id
       AND som.role = 'executive'
       AND som.is_active = true
      WHERE sup.user_id = NEW.reporting_engineer_id
        AND sup.organization_id = NEW.organization_id
    )
    ELSE NULL
  END;
  v_new_executive := COALESCE(v_new_executive, v_team.executive_user_id);

  IF v_new_executive IS NOT NULL AND v_new_executive <> NEW.user_id THEN
    WITH moved2 AS (
      UPDATE public.expenses e
      SET assigned_reviewer_id = v_new_executive,
          assigned_engineer_id = v_new_executive,
          updated_at = now()
      WHERE e.user_id = NEW.user_id
        AND e.organization_id = NEW.organization_id
        AND e.status = 'level_1_verified'
        AND e.approval_tier = 'executive'
        AND (
          e.assigned_reviewer_id IS DISTINCT FROM v_new_executive
          OR e.assigned_engineer_id IS DISTINCT FROM v_new_executive
        )
      RETURNING e.id
    )
    INSERT INTO public.audit_logs (expense_id, user_id, action, comment, organization_id)
    SELECT m.id, v_actor, 'reviewer_reassigned',
      format(
        'Pending Level 2 (executive) reviewer reassigned — employee''s hierarchy changed (old=%s, new=%s). Level 1 history is unchanged.',
        COALESCE(OLD.reporting_engineer_id::text, 'none'),
        NEW.reporting_engineer_id::text
      ),
      NEW.organization_id
    FROM moved2 m;
  END IF;

  -- ── Block 3: level_2_verified, waiting at engineer/manager stage ────────
  -- Mirrors resolveReviewerForTier('engineer', ...): the new immediate
  -- supervisor if they already are engineer/admin; else the employee's team
  -- manager; else the raw current reporting_engineer_id (never inventing a
  -- reviewer beyond what the employee's own current chain or team already
  -- provides).
  v_new_engineer := CASE
    WHEN v_new_supervisor_role IN ('engineer', 'admin') THEN NEW.reporting_engineer_id
    ELSE NULL
  END;
  v_new_engineer := COALESCE(v_new_engineer, v_team.manager_user_id, NEW.reporting_engineer_id);

  IF v_new_engineer IS NOT NULL AND v_new_engineer <> NEW.user_id THEN
    WITH moved3 AS (
      UPDATE public.expenses e
      SET assigned_reviewer_id = v_new_engineer,
          assigned_engineer_id = v_new_engineer,
          updated_at = now()
      WHERE e.user_id = NEW.user_id
        AND e.organization_id = NEW.organization_id
        AND e.status = 'level_2_verified'
        AND e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id IS DISTINCT FROM v_new_engineer
          OR e.assigned_engineer_id IS DISTINCT FROM v_new_engineer
        )
      RETURNING e.id
    )
    INSERT INTO public.audit_logs (expense_id, user_id, action, comment, organization_id)
    SELECT m.id, v_actor, 'reviewer_reassigned',
      format(
        'Pending manager/engineer reviewer reassigned — employee''s hierarchy changed (old=%s, new=%s). Level 1/Level 2 history is unchanged.',
        COALESCE(OLD.reporting_engineer_id::text, 'none'),
        NEW.reporting_engineer_id::text
      ),
      NEW.organization_id
    FROM moved3 m;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.sync_pending_expenses_on_supervisor_change() IS
  'Trigger target for profiles AFTER UPDATE OF reporting_engineer_id. Reassigns the employee''s still-pending, not-yet-completed-at-that-tier review stage (never-yet-verified, or waiting at Level 2 after Level 1 completed, or waiting at the manager/engineer stage after Level 2 completed) to the current correct reviewer for that stage. Completed tiers and their audit history are never modified. Not intended for direct invocation.';

-- Trigger function itself: no direct EXECUTE grant (unchanged from
-- 20260812121000 — this REVOKE is idempotent, re-stating the existing grant
-- state rather than changing it).
REVOKE ALL ON FUNCTION public.sync_pending_expenses_on_supervisor_change() FROM PUBLIC;

-- The trigger itself (profiles AFTER UPDATE OF reporting_engineer_id) is
-- already live from 20260812121000 and points at this same function name —
-- CREATE OR REPLACE above is sufficient; the trigger definition does not
-- need to be re-created.
