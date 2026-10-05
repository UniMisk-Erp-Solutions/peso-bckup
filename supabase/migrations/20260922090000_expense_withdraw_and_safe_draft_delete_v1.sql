-- ─────────────────────────────────────────────────────────────────────────────
-- PesoWise · Submitted-expense Withdraw + safe Draft delete (DOC-128)
--
-- INCIDENT (MicroLink)
-- ====================
-- 20260909140000_protect_non_draft_expense_history.sql correctly closed a
-- security gap: an owner could hard-delete their own SUBMITTED expense,
-- which could erase review-adjacent history. It narrowed the owner/admin
-- DELETE policies on `expenses` to status = 'draft' only.
--
-- That migration never reached the frontend: src/pages/Expenses.tsx (main)
-- still shows a "Delete" action for status = 'submitted' and still requires
-- status = 'submitted' before issuing the delete. The DELETE request
-- PostgREST sends is now filtered by RLS to zero rows; the client only
-- checked `error` (null on a legitimate zero-row delete), never the
-- returned row count, so the UI reported "Expense Deleted" while nothing
-- changed and the row reappeared on the next refetch. Reported by MicroLink
-- employees whose submitted expenses "won't delete"
-- (txns 22841/22844/22846-22850/23535 — all confirmed status='submitted',
-- zero balance deductions, zero review activity, still present).
--
-- There has never been a withdraw/cancel/recall workflow for expenses in
-- this codebase (checked full git history — see DOC-128 doc) — employees
-- who want to take back a submitted-but-not-yet-reviewed expense have had
-- no safe way to do it since the Sept 9 hotfix landed.
--
-- THIS MIGRATION
-- ==============
--   1. withdraw_submitted_expense_v1 — the new, safe replacement: recalls
--      the owner's own SUBMITTED expense back to 'draft' (editable,
--      resubmittable, excluded from every reviewer queue — the review RLS
--      policies all key off status IN ('submitted','edited','verified',
--      'level_1_verified','level_2_verified','approved'), never 'draft'),
--      PROVIDED no review action and no balance deduction has ever touched
--      it. History is kept — nothing is deleted, and an audit_logs row
--      records the withdrawal.
--   2. delete_draft_expense_v1 — replaces the browser-side, multi-call hard
--      delete of a draft (which manually deleted Storage objects,
--      attachments and audit_logs rows one Supabase call at a time with no
--      transaction around any of it) with one atomic, server-authoritative
--      function. It additionally refuses to delete a draft that was ever
--      submitted (i.e. one reached by Withdraw): only a draft with NO
--      submission history in audit_logs may be permanently erased. This
--      keeps DOC-078's "no browser code can physically delete a linked
--      receipt" guarantee intact for anything that was ever part of the
--      review/audit trail — the same class of risk an unmerged branch fix
--      (54cb7d1) was written to prevent, closed here for the new "withdraw,
--      then delete" route that fix could not have known about, and closed
--      as a real transaction instead of a blocked no-op.
--   3. A one-line RLS hardening: "Users can update their own submitted
--      expenses"' WITH CHECK did not constrain the new row's status at
--      all, so an ordinary client UPDATE could already have changed status
--      away from 'submitted' (e.g. to 'draft') with no audit trail and none
--      of the checks below. Both new RPCs are SECURITY DEFINER and bypass
--      RLS entirely, so this does not affect them; it only closes an
--      unaudited side door for ordinary client traffic. No existing feature
--      relies on the old, looser behaviour: submission/resubmission already
--      go through their own RPCs (admin_submit_expense_for_employee_v2 /
--      submit_microlink_expense_v1 / update_microlink_submitted_expense_v1),
--      and the edit form never changes `status` itself.
--
-- Race safety: both functions open with `SELECT ... FOR UPDATE` on the
-- expense row — the same lock ordering every review RPC in this schema
-- already uses (see review_approve_expense_manager_override_v1: "Lock the
-- expense first"). A concurrent reviewer action and a concurrent
-- Withdraw/Delete are fully serialized by Postgres row locking: whichever
-- commits first wins, and the other re-reads the now-current status and
-- fails its own precondition with a clear error — never a lost update, an
-- orphaned deduction, or a silently-vanishing review-queue row.
--
-- Production DML: 0. Production DDL: 0. Applying this file to Production is
-- a manual step for the project owner, per this repo's convention (no
-- migration in this diagnosis session was executed against Production).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. WITHDRAW — recall a SUBMITTED expense back to draft. Nothing is deleted.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.withdraw_submitted_expense_v1(
  p_expense_id uuid,
  p_comment    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  e           public.expenses%ROWTYPE;
  v_comment   text := nullif(trim(p_comment), '');
  v_bad_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Lock the expense first, before any status/business check, so a
  -- concurrent approve/reject/verify can never race with a withdraw.
  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.user_id <> v_uid THEN
    RAISE EXCEPTION 'You don''t have permission to withdraw this expense';
  END IF;

  IF e.organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = e.organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'You are not an active member of this expense''s organization';
  END IF;

  -- Idempotent: a repeated click after a successful withdraw is a no-op,
  -- not an error.
  IF e.status = 'draft' THEN
    RETURN jsonb_build_object(
      'ok', true, 'expense_id', p_expense_id, 'previous_status', 'draft',
      'new_status', 'draft', 'action', 'already_withdrawn'
    );
  END IF;

  IF e.status <> 'submitted' THEN
    RAISE EXCEPTION
      'Only a submitted expense can be withdrawn (current status: %). Once it has been reviewed it can no longer be recalled.',
      e.status;
  END IF;

  -- Defense in depth — both should be structurally impossible while
  -- status = 'submitted', but a financial-integrity incident must stop the
  -- withdrawal outright rather than silently proceed.
  IF EXISTS (SELECT 1 FROM public.expense_balance_deductions d WHERE d.expense_id = p_expense_id) THEN
    RAISE EXCEPTION 'This expense already has a balance deduction on record; it cannot be withdrawn. This needs manual review.';
  END IF;

  SELECT count(*) INTO v_bad_count
  FROM public.audit_logs a
  WHERE a.expense_id = p_expense_id
    AND a.action NOT IN ('expense_created', 'expense_submitted', 'expense_withdrawn', 'expense_updated');
  IF v_bad_count > 0 THEN
    RAISE EXCEPTION 'This expense already has review activity on record; it cannot be withdrawn. This needs manual review.';
  END IF;

  UPDATE public.expenses
  SET status = 'draft', updated_at = now()
  WHERE id = p_expense_id AND status = 'submitted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This expense changed status while withdrawing it. Please refresh and check its current status.';
  END IF;

  INSERT INTO public.audit_logs (organization_id, expense_id, user_id, action, comment)
  VALUES (
    e.organization_id, p_expense_id, v_uid, 'expense_withdrawn',
    trim(
      COALESCE(v_comment || ' ', '') ||
      'Withdrawn by owner before any review. Returned to Drafts; can be edited and resubmitted, or deleted.'
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'expense_id', p_expense_id, 'previous_status', 'submitted',
    'new_status', 'draft', 'action', 'withdrawn'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.withdraw_submitted_expense_v1(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.withdraw_submitted_expense_v1(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.withdraw_submitted_expense_v1(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.withdraw_submitted_expense_v1(uuid, text) IS
  'Recalls the caller''s own submitted expense to draft, provided no review action or balance deduction has ever touched it. Idempotent; writes an expense_withdrawn audit_logs row; never deletes anything.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. SAFE DRAFT DELETE — one atomic call, replaces the browser-side,
--    multi-request hard delete. Refuses a draft that was ever submitted.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.delete_draft_expense_v1(
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  e                public.expenses%ROWTYPE;
  v_ever_submitted boolean;
  v_paths          text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Idempotent: already gone is a successful outcome for a delete action.
    RETURN jsonb_build_object(
      'ok', true, 'expense_id', p_expense_id, 'action', 'already_deleted', 'attachment_paths', '[]'::jsonb
    );
  END IF;

  IF e.user_id <> v_uid THEN
    RAISE EXCEPTION 'You don''t have permission to delete this expense';
  END IF;

  IF e.organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = e.organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'You are not an active member of this expense''s organization';
  END IF;

  IF e.status <> 'draft' THEN
    RAISE EXCEPTION
      'Only a draft expense can be permanently deleted (current status: %). A submitted expense can be withdrawn instead.',
      e.status;
  END IF;

  IF EXISTS (SELECT 1 FROM public.expense_balance_deductions d WHERE d.expense_id = p_expense_id) THEN
    RAISE EXCEPTION 'This expense already has a balance deduction on record; it cannot be deleted. This needs manual review.';
  END IF;

  -- The one rule that matters: a draft that was ever submitted (i.e. one
  -- reached by Withdraw) carries real review-adjacent history and must be
  -- protected exactly like a submitted expense is — only a draft that was
  -- NEVER submitted may be permanently erased.
  SELECT EXISTS (
    SELECT 1 FROM public.audit_logs a
    WHERE a.expense_id = p_expense_id AND a.action = 'expense_submitted'
  ) INTO v_ever_submitted;

  IF v_ever_submitted THEN
    RAISE EXCEPTION
      'This expense was previously submitted and withdrawn, so it carries audit history and cannot be permanently deleted. You can edit it and resubmit it instead.';
  END IF;

  SELECT array_remove(array_agg(a.storage_path), NULL) INTO v_paths
  FROM public.attachments a
  WHERE a.expense_id = p_expense_id;

  -- Never submitted, so its only audit_logs row(s) can be 'expense_created'
  -- — no review-adjacent history exists to protect.
  DELETE FROM public.attachments WHERE expense_id = p_expense_id;
  DELETE FROM public.audit_logs WHERE expense_id = p_expense_id;
  DELETE FROM public.expenses WHERE id = p_expense_id;

  -- Storage objects live outside Postgres and cannot be deleted inside this
  -- transaction; the caller removes them best-effort afterwards using the
  -- paths returned here. Losing that race only leaks a Storage object for
  -- an expense that was never part of any review — never an audit gap.
  --
  -- batch_id/organization_id are handed back (not looked up again) so the
  -- caller can resync the parent batch's aggregates exactly as the previous
  -- client-side implementation did for a batch child left behind in draft.
  RETURN jsonb_build_object(
    'ok', true, 'expense_id', p_expense_id, 'action', 'deleted',
    'attachment_paths', to_jsonb(COALESCE(v_paths, ARRAY[]::text[])),
    'batch_id', e.batch_id, 'organization_id', e.organization_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_draft_expense_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_draft_expense_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_draft_expense_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_draft_expense_v1(uuid) IS
  'Permanently deletes the caller''s own draft expense (attachments + audit_logs + the row), atomically, ONLY if it was never submitted. Idempotent. Returns attachment storage paths for best-effort client-side Storage cleanup.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. RLS hardening — close the unaudited status side-door on the existing
--    "edit a submitted expense" policy. Pure narrowing: every currently
--    legitimate use of this policy already leaves status untouched.
-- ══════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users can update their own submitted expenses" ON public.expenses;

CREATE POLICY "Users can update their own submitted expenses"
ON public.expenses FOR UPDATE
USING (
  auth.uid() = user_id
  AND status = 'submitted'::expense_status
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid() AND om.organization_id = expenses.organization_id AND om.is_active = true
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND organization_id IS NOT NULL
  AND status = 'submitted'::expense_status
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid() AND om.organization_id = expenses.organization_id AND om.is_active = true
  )
);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. INSTALL-TIME PROOF — the migration must not change a single business row
-- ══════════════════════════════════════════════════════════════════════════
DO $verify$
BEGIN
  IF to_regprocedure('public.withdraw_submitted_expense_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'withdraw_submitted_expense_v1 was not installed';
  END IF;
  IF to_regprocedure('public.delete_draft_expense_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'delete_draft_expense_v1 was not installed';
  END IF;
  IF NOT public.expense_status_transition_allowed_v1('submitted', 'draft') THEN
    RAISE EXCEPTION 'rule regression: submitted -> draft must stay legal for Withdraw to work';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.expenses'::regclass
      AND polname = 'Users can update their own submitted expenses'
      AND pg_get_expr(polwithcheck, polrelid) ILIKE '%status = ''submitted''::expense_status%'
  ) THEN
    RAISE EXCEPTION 'RLS hardening did not take effect';
  END IF;
END
$verify$;

COMMIT;
