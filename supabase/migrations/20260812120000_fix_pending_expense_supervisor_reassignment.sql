-- Debug branch debug/6456-supervisor-auth-runtime — repro case: employee 6546
-- (MicroLink), reassigned from Supervisor A (Mahamkali Venkateswara Rao,
-- employee 6196) to Supervisor B (Kunvar Thakor, employee 5022).
--
-- Root cause (confirmed live, read-only, against Production):
-- `expense_hierarchy_reviewer_can_act(e, v_uid)` authorizes a team_leader/
-- executive-tier Verify ONLY when the caller literally equals the expense's
-- OWN snapshotted `assigned_reviewer_id`/`assigned_engineer_id` — the value
-- captured at submission time. It never consults the employee's CURRENT
-- `profiles.reporting_engineer_id`. When an employee's immediate supervisor
-- changes, expenses that were already pending at that stage keep pointing at
-- the PREVIOUS supervisor forever — the new supervisor's Verify is rejected
-- with "You don't have permission to verify this expense at the current
-- tier", even though they are visible in the new supervisor's queue (queue
-- *visibility* — `manager_expense_visible_to_user` and the reviewer-scope
-- walk — already follows current `reporting_engineer_id` correctly; only
-- this *mutation-authority* check does not). This is the confirmed
-- queue-says-visible / mutation-says-no contract defect.
--
-- Fix (Option A — dynamic authority, additive OR-branch, snapshot path
-- untouched): a caller who is NOT the snapshotted reviewer/engineer may still
-- act if ALL of the following hold:
--   * the expense has not yet been verified at ANY hierarchy tier (status is
--     still submitted/edited/under_review — level_1_verified,
--     level_2_verified and every terminal status are excluded, so history
--     and already-advanced tiers are never touched or rewound);
--   * the caller IS the employee's CURRENT immediate supervisor per
--     profiles.reporting_engineer_id (cross-org isolation preserved via the
--     organization_id match; self-review excluded via the v_uid <> e.user_id
--     guard);
--   * the caller holds active team_leader/executive organization membership
--     (i.e. is actually capable of holding hierarchy authority at all).
-- The caller's OWN role — not the expense's stale approval_tier label —
-- decides what tier they are acting at; review_advance_expense_hierarchy_tier
-- already derives v_is_tl/v_is_exec from the caller's real membership role
-- independently, so no change is needed there. The previous supervisor loses
-- authority automatically the moment they stop being the employee's current
-- reporting_engineer_id, without any data being rewritten.
--
-- Read-only function (STABLE SECURITY DEFINER, no data mutation). Signature,
-- return type, SET search_path and grants are all preserved.
-- Rollback: the change is purely additive (one new `OR (...)` branch); the
-- entire original body is reproduced verbatim as the first disjunct above,
-- so rolling back is deleting that branch and re-deploying. The exact
-- pre-migration live body was captured read-only via pg_get_functiondef()
-- immediately before this migration was applied to Production
-- (2026-08-12), byte-exact via `psql -At`, sha256
-- db79069afbadef89a0cb2f6e98a1c36c9d4bca8af799e40ef774c3b9dff15513 (of the
-- captured file, `\r`-terminated lines as returned by psql). Full text:
--
-- CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act(e expenses, v_uid uuid)
--  RETURNS boolean
--  LANGUAGE sql
--  STABLE SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
--   SELECT EXISTS (
--     SELECT 1
--     FROM public.organization_memberships om
--     WHERE om.user_id = v_uid
--       AND om.organization_id = e.organization_id
--       AND om.is_active = true
--       AND (
--         (
--           om.role = 'team_leader'
--           AND (
--             e.approval_tier IS NULL
--             OR e.approval_tier IN ('team_leader', 'engineer')
--           )
--         )
--         OR (
--           om.role = 'executive'
--           AND (
--             e.approval_tier IS NULL
--             OR e.approval_tier IN ('executive', 'engineer')
--           )
--         )
--       )
--   )
--   AND (
--     e.assigned_reviewer_id = v_uid
--     OR e.assigned_engineer_id = v_uid
--   );
-- $function$;
CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act(e expenses, v_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (
      EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = v_uid
          AND om.organization_id = e.organization_id
          AND om.is_active = true
          AND (
            (
              om.role = 'team_leader'
              AND (
                e.approval_tier IS NULL
                OR e.approval_tier IN ('team_leader', 'engineer')
              )
            )
            OR (
              om.role = 'executive'
              AND (
                e.approval_tier IS NULL
                OR e.approval_tier IN ('executive', 'engineer')
              )
            )
          )
      )
      AND (
        e.assigned_reviewer_id = v_uid
        OR e.assigned_engineer_id = v_uid
      )
    )
    OR (
      -- Current-supervisor fallback: still pending, never verified at any
      -- hierarchy tier yet, and the caller is the employee's CURRENT
      -- immediate supervisor (not the stale snapshot).
      v_uid <> e.user_id
      AND e.status::text IN ('submitted', 'edited', 'under_review')
      AND EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = v_uid
         AND om.organization_id = e.organization_id
         AND om.is_active = true
         AND om.role IN ('team_leader', 'executive')
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = v_uid
      )
    );
$function$;

GRANT EXECUTE ON FUNCTION public.expense_hierarchy_reviewer_can_act(expenses, uuid) TO PUBLIC;
