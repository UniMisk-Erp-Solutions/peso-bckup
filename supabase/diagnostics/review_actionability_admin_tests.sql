-- Contract tests for public._debug_review_actionability_v1 after migration
-- 20260810120000 (org-admin super-approver). READ ONLY: pure function calls,
-- no table access, no writes. Run against any DB that has the function:
--   docker exec -i <db> psql -U supabase_admin -d postgres -f - < this_file
-- Every ASSERT raises 'contract violated: ...' on failure; a clean run prints
-- NOTICEs only. UUIDs below are arbitrary non-null placeholders.

DO $$
DECLARE
  admin_id uuid := '00000000-0000-0000-0000-0000000000a1';
  other_id uuid := '00000000-0000-0000-0000-0000000000b2';
  r jsonb;
BEGIN
  -- 1) THE FIX: admin, submitted, executive tier, NOT the assigned reviewer/eng.
  --    Live-proven defect shape (MicroLink txns 10483/10484/10485).
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'submitted', 'executive', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: admin submitted/executive must be actionable';
  ASSERT (r->'available_actions') ? 'approve',
    'contract violated: admin submitted/executive must offer approve';
  ASSERT (r->>'view_only')::boolean IS FALSE,
    'contract violated: admin submitted/executive must not be view_only';
  ASSERT r->>'actionable_reason' = 'admin_approvable',
    'contract violated: reason must be admin_approvable';

  -- 2) admin, submitted, team_leader tier → actionable (skips hierarchy).
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'submitted', 'team_leader', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: admin submitted/team_leader must be actionable';

  -- 3) admin, level_2_verified → actionable.
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'level_2_verified', 'executive', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: admin level_2_verified must be actionable';

  -- 4) admin, approved (terminal) → NOT actionable, view_only (unchanged).
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'approved', 'executive', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS FALSE,
    'contract violated: approved must stay terminal for admin';
  ASSERT (r->>'view_only')::boolean IS TRUE,
    'contract violated: approved must stay view_only';

  -- 5) admin, verified → NOW actionable. Migration 20260810140000 aligned the
  --    queue with review_approve_expense (which allows admin approval of
  --    verified; balance not yet deducted), superseding the interim
  --    20260810120000 behaviour where verified was still terminal. Full verified
  --    coverage is in tests 9-10 and 12.
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'verified', 'executive', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: admin verified must now be actionable (aligned with V2)';

  -- 6) NON-ADMIN REGRESSION GUARD: executive, submitted, executive tier, NOT the
  --    assigned reviewer → still NOT actionable (no widening for non-admins).
  r := public._debug_review_actionability_v1(
        'executive', other_id, 'submitted', 'executive', admin_id, admin_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS FALSE,
    'contract violated: unassigned executive must remain not actionable';
  ASSERT r->>'actionable_reason' = 'not_assigned_to_caller',
    'contract violated: unassigned executive reason must be not_assigned_to_caller';

  -- 7) executive who IS the assigned reviewer at executive tier → actionable,
  --    verify/reject (unchanged tier-reviewer behaviour).
  r := public._debug_review_actionability_v1(
        'executive', other_id, 'submitted', 'executive', other_id, null,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: assigned executive must be actionable';
  ASSERT (r->'available_actions') ? 'verify',
    'contract violated: assigned executive must offer verify';
  ASSERT NOT ((r->'available_actions') ? 'approve'),
    'contract violated: executive must not be offered approve';

  -- 8) engineer assigned at engineer tier → actionable, approve (unchanged).
  r := public._debug_review_actionability_v1(
        'engineer', other_id, 'submitted', 'engineer', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: assigned engineer must be actionable';
  ASSERT (r->'available_actions') ? 'approve',
    'contract violated: assigned engineer must offer approve';

  -- 9) VERIFIED alignment (migration 20260810140000). Admin may approve a
  --    'verified' expense (V1 IF v_is_admin allows it; balance not yet deducted).
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'verified', 'executive', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS TRUE,
    'contract violated: admin verified must be actionable';
  ASSERT (r->'available_actions') ? 'approve',
    'contract violated: admin verified must offer approve';
  ASSERT (r->>'view_only')::boolean IS FALSE,
    'contract violated: admin verified must not be view_only';
  ASSERT r->>'actionable_reason' = 'admin_approvable',
    'contract violated: admin verified reason must be admin_approvable';

  -- 10) NON-ADMIN REGRESSION GUARD: a non-admin does NOT gain rights on verified.
  --     Even an executive who is the assigned reviewer is view-only on verified
  --     (it is past their tier and is a terminal status for non-admins).
  r := public._debug_review_actionability_v1(
        'executive', other_id, 'verified', 'executive', other_id, NULL,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS FALSE,
    'contract violated: non-admin verified must remain not actionable';
  ASSERT (r->>'view_only')::boolean IS TRUE,
    'contract violated: non-admin verified must remain view_only';
  r := public._debug_review_actionability_v1(
        'engineer', other_id, 'verified', 'engineer', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS FALSE,
    'contract violated: engineer verified must remain not actionable';

  -- 11) admin approved/rejected stay terminal (not swallowed into admin path).
  r := public._debug_review_actionability_v1(
        'admin', admin_id, 'rejected', 'executive', other_id, other_id,
        true, true, true, false);
  ASSERT (r->>'is_actionable')::boolean IS FALSE,
    'contract violated: admin rejected must stay terminal';

  -- 12) STATUS CLASSIFICATION: verified is now a PENDING workflow status;
  --     genuine terminal statuses remain terminal.
  ASSERT public._debug_review_status_class_v1('verified') = 'pending',
    'contract violated: verified must classify as pending';
  ASSERT public._debug_review_status_class_v1('submitted') = 'pending',
    'contract violated: submitted must classify as pending';
  ASSERT public._debug_review_status_class_v1('level_2_verified') = 'pending',
    'contract violated: level_2_verified must classify as pending';
  ASSERT public._debug_review_status_class_v1('approved') = 'terminal',
    'contract violated: approved must classify as terminal';
  ASSERT public._debug_review_status_class_v1('rejected') = 'terminal',
    'contract violated: rejected must classify as terminal';
  ASSERT public._debug_review_status_class_v1('paid') = 'terminal',
    'contract violated: paid must classify as terminal';

  RAISE NOTICE 'review_actionability_admin_tests: ALL ASSERTIONS PASSED';
END $$;
