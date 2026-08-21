-- DOC-098 — Fail-closed hardening of expense_hierarchy_reviewer_can_act.
--
-- ============================================================================
-- STATUS: DEBUG-BRANCH ONLY at commit time. Scheduled for same-day Production
-- deployment per explicit owner authorization (DOC-098 §11/§12). This is a
-- correction to an EXISTING, already-deployed Production function —
-- additive only (CREATE OR REPLACE preserving the exact signature/behavior
-- for every case that previously returned a definite true/false); no table
-- or RLS change. Grants ARE tightened (see the privilege-audit note below) —
-- this is the one intentional non-behavioral change alongside the NULL fix.
-- ============================================================================
--
-- BUG (found while transactionally proof-testing the new
-- review_verify_batch_atomic_v1 RPC, see that migration and DOC-098):
-- expense_hierarchy_reviewer_can_act(e, v_uid) can return SQL NULL, not just
-- true/false. Its body is two OR'd conditions, each containing a nullable
-- equality comparison:
--   * `e.assigned_reviewer_id = v_uid OR e.assigned_engineer_id = v_uid` —
--     when assigned_engineer_id IS NULL (the normal state for nearly every
--     pending team_leader/executive-tier expense, since it's only populated
--     once the expense reaches the engineer tier), that comparison is NULL,
--     not false. If assigned_reviewer_id also doesn't match v_uid, the whole
--     disjunct is `false OR NULL` = NULL under three-valued logic, not false.
--   * The current-supervisor fallback similarly compares
--     `p.reporting_engineer_id = v_uid`, which is NULL when the employee has
--     no current supervisor set.
-- When BOTH disjuncts evaluate to NULL (a correctly-roled, correctly-orged
-- caller who is simply not the assigned reviewer and not the current
-- supervisor), the function's overall result is `NULL OR NULL` = NULL.
--
-- This is a live, currently-deployed defect, not just a risk in new code.
-- Proven live (BEGIN/ROLLBACK, zero persistence) against
-- review_advance_expense_hierarchy_tier's real Production body: a caller
-- with active team_leader/executive membership in the right org, NOT the
-- expense's assigned_reviewer_id/assigned_engineer_id and NOT the employee's
-- current supervisor, gets `expense_hierarchy_reviewer_can_act(...) = NULL`.
-- Every live caller of this helper that guards with
-- `IF NOT expense_hierarchy_reviewer_can_act(...) THEN RAISE EXCEPTION ...`
-- (review_advance_expense_hierarchy_tier — the live hierarchy Verify RPC —
-- and review_reject_expense — the live Reject RPC) evaluates `NOT NULL` as
-- NULL, and PL/pgSQL's `IF` only enters its branch on a definite TRUE — a
-- NULL condition silently skips the RAISE EXCEPTION, so the mutation
-- proceeds as if the caller HAD been authorized. In effect: any active
-- team_leader/executive in an organization can currently verify or reject
-- another team_leader/executive's assigned expenses, not just their own.
--
-- FIX: wrap the existing, UNCHANGED boolean expression in COALESCE(..., false).
-- This is universally safe — it can only ever turn a previously-ambiguous
-- NULL into false. It can never turn a legitimately-authorized case into
-- false, because every real "this caller IS authorized" path in this
-- function's body compares a snapshotted id to the caller's OWN v_uid and
-- produces a definite TRUE by construction when they match (a NULL only
-- arises from a NON-match against a NULL-valued column, which is exactly the
-- "not authorized via this path" case that should already deny).
--
-- Every historical, already-superseded body of this function used the same
-- unguarded pattern; only the CURRENT live body needs correcting, since
-- CREATE OR REPLACE replaces whatever is deployed today. Full text preserved
-- verbatim below except for the added COALESCE wrapper, so this changes
-- exactly one thing: NULL -> false.
--
-- Rollback: CREATE OR REPLACE back to the exact prior body (captured in
-- supabase/migrations/20260812120000_fix_pending_expense_supervisor_reassignment.sql,
-- the function's last unmodified definition) — see
-- supabase/rollbacks/20260819150000_fail_closed_hierarchy_reviewer_can_act_rollback.sql.
--
-- PRIVILEGE AUDIT (DOC-098 same-day security review, GATE 2): the live
-- Production grant was `GRANT EXECUTE ... TO PUBLIC` (which implicitly
-- covers anon/authenticated/service_role too). Checked every legitimate
-- caller: (a) no live RLS policy on `expenses` references this function —
-- the one that did, from the original 20260524160000 migration, was
-- superseded; (b) no frontend code calls it directly via supabase.rpc();
-- (c) every real caller (review_advance_expense_hierarchy_tier,
-- review_reject_expense, reviewer_can_act_on_expense,
-- review_verify_batch_atomic_v1) is itself SECURITY DEFINER and owned by
-- the SAME role (supabase_admin) as this function, so ownership alone
-- already lets them call it regardless of PUBLIC/anon/authenticated grants.
-- No legitimate anonymous or public caller was found. Narrowed to
-- REVOKE FROM PUBLIC/anon, GRANT TO authenticated only — the minimum that
-- keeps every proven-legitimate path working (function-owner calls are
-- unaffected by any of this; `authenticated` is kept as a conservative
-- margin in case a future direct-authenticated-user call path is added).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act(e expenses, v_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = ''
AS $function$
  SELECT COALESCE(
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
    ),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.expense_hierarchy_reviewer_can_act(expenses, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_hierarchy_reviewer_can_act(expenses, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_hierarchy_reviewer_can_act(expenses, uuid) TO authenticated;

COMMENT ON FUNCTION public.expense_hierarchy_reviewer_can_act(public.expenses, uuid) IS
  'Fail-closed (DOC-098): identical logic to the prior body, wrapped in '
  'COALESCE(..., false) so an ambiguous/NULL result (e.g. caller matches '
  'neither a NULL assigned_engineer_id nor a NULL reporting_engineer_id) '
  'denies instead of silently passing IF NOT ... THEN checks in every '
  'existing caller. Least-privilege grant (authenticated only; no live '
  'RLS policy or frontend caller requires PUBLIC/anon -- see privilege '
  'audit above).';
