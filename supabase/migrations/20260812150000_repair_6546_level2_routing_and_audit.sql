-- One-time data repair (owner-authorized): 100 real MicroLink expenses for
-- employee 6546 (Aswinkumar) currently show status='level_2_verified' with
-- approval_tier='executive' and zero tier_advanced audit trail.
--
-- Root cause (proven via read-only forensic audit against Production, live
-- pg_get_functiondef and Git history of both `main` and this debug branch):
-- the deployed `main`-branch ExpenseService.advanceExpenseTier() derived the
-- verify "tier" from the expense's own stale approval_tier snapshot
-- ('team_leader', from the original 2026-07-04 submission), not from the
-- caller's real current role. Kunvar Thakor (role: executive) became the
-- assigned reviewer for these rows via this morning's separate, correct,
-- reviewer-pointer-only repair (supervisor_reassignment_repair_log, batch
-- 'microlink_2026-08-12'). When he verified them, the server (authoritative
-- on status) correctly advanced status to level_2_verified, but the client
-- stored the wrong approval_tier ('executive', computed from the stale
-- snapshot) and then threw the legacy "Run Supabase migration
-- 20260524260000..." error — BEFORE reaching the audit-log write — because
-- its own predicted status ('level_1_verified') did not match the server's
-- real one. The database write had already committed atomically inside the
-- RPC; only the client-side audit insert and the approval_tier value were
-- wrong. This is the exact Issue 2 (role/tier divergence) defect this debug
-- branch already fixes (see 07495ac); that fix was not yet deployed to
-- Production when this happened.
--
-- This migration does NOT re-run verification. It corrects the metadata to
-- match what a correct verification would have produced, using the 58
-- sibling expenses (verified via the same real action, same day, whose
-- client-side tier snapshot happened to already be correct) as the proven
-- reference for what "correct" looks like for this employee: assigned
-- reviewer/engineer already equals Kunvar Thakor for all 158 rows (there is
-- no team configured for this employee, so the app's own routing already
-- keeps the acting executive as the final-tier assignee — proven by 58/58
-- consistent real outcomes, not assumed). Only approval_tier is wrong.
--
-- Repair marker: 6546_level2_metadata_repair_20260812
-- Idempotent: reruns naturally affect 0 rows, because the candidate WHERE
-- clause (approval_tier = 'executive') no longer matches after the first run.

DO $$
DECLARE
  v_org_id uuid;
  v_employee_id uuid;
  v_kunvar_id uuid;
  v_candidate_count integer;
  v_bad_precondition_count integer;
  v_updated_count integer;
  v_audit_inserted_count integer;
BEGIN
  -- Resolve organization + employee identity from stable business keys, not
  -- hardcoded UUIDs, so this migration fails loudly if identity has drifted.
  SELECT id INTO v_org_id FROM public.organizations WHERE name ILIKE '%microlink%';
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Repair aborted: MicroLink organization not found';
  END IF;

  SELECT p.user_id INTO v_employee_id
  FROM public.profiles p
  WHERE p.employee_id = '6546' AND p.organization_id = v_org_id;
  IF v_employee_id IS NULL THEN
    RAISE EXCEPTION 'Repair aborted: employee_id 6546 not found in MicroLink';
  END IF;

  SELECT p.reporting_engineer_id INTO v_kunvar_id
  FROM public.profiles p
  WHERE p.user_id = v_employee_id;
  IF v_kunvar_id IS NULL THEN
    RAISE EXCEPTION 'Repair aborted: employee 6546 has no current reporting_engineer_id';
  END IF;

  -- The exact, forensically-proven candidate population.
  CREATE TEMP TABLE repair_candidates ON COMMIT DROP AS
  SELECT e.id, e.updated_at AS original_updated_at
  FROM public.expenses e
  WHERE e.user_id = v_employee_id
    AND e.organization_id = v_org_id
    AND e.status = 'level_2_verified'
    AND e.approval_tier = 'executive'
    AND e.approved_by IS NULL
    AND e.approved_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_logs al
      WHERE al.expense_id = e.id AND al.action = 'tier_advanced'
    );

  SELECT count(*) INTO v_candidate_count FROM repair_candidates;

  -- Idempotent no-op on rerun: nothing left to repair.
  IF v_candidate_count = 0 THEN
    RAISE NOTICE 'Repair: 0 candidate rows found — already repaired or nothing to do.';
    RETURN;
  END IF;

  IF v_candidate_count <> 100 THEN
    RAISE EXCEPTION
      'Repair aborted: expected exactly 100 candidate rows, found %. Refusing to proceed on an unproven population.',
      v_candidate_count;
  END IF;

  -- Defensive: every candidate's current assigned_reviewer_id/assigned_engineer_id
  -- must already equal the proven-correct value (Kunvar) — if any candidate
  -- disagrees, routing metadata is corrupt in a way this migration does not
  -- understand, and it must not guess.
  SELECT count(*) INTO v_bad_precondition_count
  FROM public.expenses e
  JOIN repair_candidates rc ON rc.id = e.id
  WHERE e.assigned_reviewer_id IS DISTINCT FROM v_kunvar_id
     OR e.assigned_engineer_id IS DISTINCT FROM v_kunvar_id
     OR e.status <> 'level_2_verified'
     OR e.approval_tier <> 'executive';

  IF v_bad_precondition_count <> 0 THEN
    RAISE EXCEPTION
      'Repair aborted: % candidate row(s) do not match the proven pre-repair state (assigned_reviewer/engineer must already be %). Refusing to proceed.',
      v_bad_precondition_count, v_kunvar_id;
  END IF;

  -- The actual repair: approval_tier only. assigned_reviewer_id/assigned_engineer_id
  -- are already correct (proven above) and are deliberately left untouched.
  -- status, amounts, attachments, category, batch_id, transaction_number,
  -- approved_by, approved_at are never referenced in this UPDATE.
  -- updated_at is deliberately NOT set — the existing value is the real,
  -- provable timestamp of when the server-side transition actually
  -- committed, and preserving it is more truthful than overwriting it with
  -- the repair time.
  UPDATE public.expenses e
  SET approval_tier = 'engineer'
  FROM repair_candidates rc
  WHERE e.id = rc.id;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count <> 100 THEN
    RAISE EXCEPTION 'Repair aborted mid-flight: updated % rows, expected 100.', v_updated_count;
  END IF;

  -- Truthful, non-fabricated audit evidence. Attributed to Kunvar Thakor
  -- because the forensic investigation proved he performed the real
  -- server-side Level 2 action; the comment clearly distinguishes the
  -- historical event (per-row provable timestamp) from this reconstruction
  -- (recorded now). action = 'tier_advanced' because that is genuinely what
  -- happened; no financial action, no re-verification.
  INSERT INTO public.audit_logs (expense_id, user_id, action, comment, organization_id)
  SELECT
    rc.id,
    v_kunvar_id,
    'tier_advanced',
    format(
      'Audit repair (6546_level2_metadata_repair_20260812): Level 2 (executive) verification by Kunvar Thakor was already committed server-side on %s (proven via this expense''s own pre-repair updated_at); the live client threw a client-side tier-mismatch error before writing this audit entry, and stored the wrong approval_tier (''executive''). This entry backfills the missing audit trail and corrects approval_tier to ''engineer''. No re-verification was performed; status and all financial fields are unchanged.',
      to_char(rc.original_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ),
    v_org_id
  FROM repair_candidates rc;
  GET DIAGNOSTICS v_audit_inserted_count = ROW_COUNT;

  IF v_audit_inserted_count <> 100 THEN
    RAISE EXCEPTION 'Repair aborted mid-flight: inserted % audit rows, expected 100.', v_audit_inserted_count;
  END IF;

  RAISE NOTICE 'Repair complete: % rows corrected, % audit entries backfilled.', v_updated_count, v_audit_inserted_count;
END $$;
