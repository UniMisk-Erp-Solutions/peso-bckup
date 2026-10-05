-- Admin-controlled expense date locking (DOC-138, hotfix 2026-10-01).
--
-- Lets an organization admin block NEW expense submissions / date changes
-- for a chosen date, month, or custom range (e.g. "books closed for
-- August"). Gated end-to-end by the existing organization_features
-- framework (key: expense_date_locking) -- when the feature is OFF,
-- behavior is byte-for-byte unchanged from before this migration, even if
-- lock rows happen to exist.
--
-- Enforcement lives at the DATABASE TRIGGER level on public.expenses, not
-- only in a single RPC -- the same "catch it no matter which path writes
-- the row" posture this codebase already uses for the expense
-- status-transition invariant (see
-- 20260907220000_expense_state_machine_and_transaction_number_integrity.sql's
-- own trg_enforce_expense_status_transition). A UI-only date-picker
-- restriction is UX, never security -- the trigger is what actually makes
-- the lock unbypassable.
--
-- 2026-10-01 REVIEW FIX (this trigger was initially too broad): the first
-- version blocked EVERY INSERT with a locked trip_start, regardless of
-- status. That is broader than the real business requirement -- a brand
-- new DRAFT (or any other non-submitted row) must never be blocked just
-- because a lock exists; the lock only governs the actual SUBMISSION
-- event. The condition below now enforces the BUSINESS EVENT instead of
-- the raw TG_OP, derived from auditing every real write path into
-- `expenses` on this branch (see "Write paths audited" below) rather than
-- guessed. The state machine itself (see the state-machine migration
-- referenced above) already establishes the vocabulary this trigger reuses:
-- 'draft' / 'rejected' / 'edited' are the pre-submission "editing" states;
-- 'submitted' is the one legal gateway into the protected review workflow
-- (under_review / verified / level_1_verified / level_2_verified / approved
-- / paid); nothing ever enters a protected state except via 'submitted'
-- first (enforced separately by trg_enforce_expense_status_transition).
-- Given that, "a new submission happened" is precisely and only: this row
-- NOW has status = 'submitted' AND this write is what made that true (a
-- fresh INSERT already at 'submitted', a transition INTO 'submitted' from
-- draft/rejected/edited, or a trip_start change while remaining submitted).
--
-- Write paths audited (grep across src/services, src/lib, src/pages, and
-- every supabase/migrations/*.sql referencing `INSERT INTO public.expenses`
-- or an UPDATE of its `status` column):
--   1. src/services/ExpenseService.ts `createExpense()` -- single-expense
--      INSERT, ALWAYS status='draft' ("Create first, then submitExpense()
--      will move it to submitted"). The actual submission is a SEPARATE
--      later UPDATE (`submitExpense()` -> `.update({status:'submitted'})`).
--   2. src/services/ExpenseService.ts `submitExpenseBatch()` -- each batch
--      line reuses `createExpense()` (draft INSERT) then calls
--      `submitExpense()` per line, same two-step shape as #1.
--   3. supabase/migrations/20260828100000_admin_submit_expense_for_employee_v2.sql
--      -- a REAL, direct-to-submitted INSERT (`status, ... 'submitted'`,
--      comment: "Create the expense as 'submitted'"). This is a genuine,
--      live, user-facing action (an admin submitting ON BEHALF OF an
--      employee) and MUST respect the lock exactly like a normal
--      submission -- there is no reason an admin-submitted expense should
--      bypass a date lock a self-submitted one cannot.
--   4. supabase/migrations/20260909100000_microlink_atomic_submission_v1.sql
--      -- MicroLink's one-shot atomic path also INSERTs directly at
--      status='submitted' when `p_action='submit'` and no existing row
--      matched (`v_status := CASE WHEN p_action='submit' THEN 'submitted'
--      ELSE 'draft' END`). Same reasoning as #3: a genuine live submission,
--      must respect the lock.
--   5. Review/approval RPCs (review_approve_expense_manager_override_v1,
--      review_admin_verify_expense, review_approve_expense_v2, etc.) only
--      ever UPDATE an ALREADY-submitted row's status among the protected
--      states (submitted -> under_review -> ... -> approved/paid), and
--      per trg_enforce_expense_status_transition's own invariant can never
--      arrive at a protected state from 'draft' except via 'submitted'
--      first. None of these transitions ever has NEW.status = 'submitted'
--      (they move PAST it), so this trigger structurally never fires for
--      them -- "unrelated administrative review transitions must remain
--      unaffected" holds by construction, not by a special-cased exclusion.
--   6. Admin corrections (allow_manager_admin_expense_corrections) set
--      status='edited', never keep it at 'submitted' -- this trigger does
--      not fire on the correction itself (editing is always allowed,
--      matching "historical expenses stay untouched"); it fires again only
--      if/when the corrected row is RE-submitted (edited -> submitted),
--      which is exactly when the lock should apply.
--
-- Backup/Restore / historical import / migration / administrative
-- backfill impact: audited and found NOT APPLICABLE on this branch today.
-- This branch is cut from `main`, which does not yet contain ANY
-- Backup/Restore code (Restore lives only on the separate, unmerged
-- `integration/backup-restore-v2-ready` branch) -- there is currently no
-- bulk-historical-insert path into `expenses` anywhere in this codebase to
-- audit. This is written down explicitly for whenever that branch is
-- integrated: a bulk historical restore that recreates an OLD row already
-- at status='submitted' (or any protected state) would, under this
-- trigger's rule, still be subject to the CURRENT lock state at restore
-- time, which is almost certainly not desired for data that was genuinely
-- submitted before the lock ever existed. The standard, zero-risk fix for
-- that future integration is for the restore transaction to run with
-- `SET LOCAL session_replication_role = replica;` (or to explicitly
-- `ALTER TABLE expenses DISABLE TRIGGER enforce_expense_date_lock` for the
-- duration of its own transaction) -- a bulk loader bypassing per-row
-- business-rule triggers is the standard, safe Postgres pattern for this,
-- and it do NOT need to be implemented here since the code it would apply
-- to does not exist on this branch.
--
-- What the trigger does NOT do: it never touches an existing row just
-- because a lock is created after the fact (task requirement -- "historical
-- expenses stay untouched") -- a non-submitted INSERT or an update that
-- never touches 'submitted'/'trip_start' never reaches the check at all.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Lock-period table
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.organization_expense_date_locks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  date_from       date NOT NULL,
  date_to         date NOT NULL,
  reason          text,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_expense_date_locks_range_check CHECK (date_from <= date_to)
);

CREATE INDEX IF NOT EXISTS idx_organization_expense_date_locks_org
  ON public.organization_expense_date_locks (organization_id);

-- Supports the trigger's own lookup (active locks for an org, filtered by
-- range) without a sequential scan once an organization accumulates many
-- lock rows across its history.
CREATE INDEX IF NOT EXISTS idx_organization_expense_date_locks_active_range
  ON public.organization_expense_date_locks (organization_id, date_from, date_to)
  WHERE is_active = true;

COMMENT ON TABLE public.organization_expense_date_locks IS
  'Admin-defined date ranges (single date, month, or custom range) during which NEW expense submissions / expense-date changes are blocked for that organization. Enforced only when organization_features.expense_date_locking is enabled. Disabling a row (is_active=false) is preferred over deleting it, to preserve an audit trail of what was locked and when -- see deactivate_expense_date_lock_v1.';

ALTER TABLE public.organization_expense_date_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_date_locks_select" ON public.organization_expense_date_locks;
DROP POLICY IF EXISTS "expense_date_locks_admin_write" ON public.organization_expense_date_locks;

-- Any active member of the organization can SEE the lock list (the
-- employee-side date picker needs to read active ranges to disable dates),
-- but only an active organization admin of THAT SAME organization can
-- create or modify one -- RLS is the first gate; create_expense_date_lock_v1
-- / deactivate_expense_date_lock_v1 re-check is_org_admin() explicitly as a
-- second, defense-in-depth gate (same posture as every other admin-mutating
-- RPC in this codebase, e.g. create_backup_export_job_v1).
CREATE POLICY "expense_date_locks_select"
  ON public.organization_expense_date_locks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships m
      WHERE m.user_id = auth.uid()
        AND m.organization_id = organization_expense_date_locks.organization_id
        AND COALESCE(m.is_active, true) = true
    )
  );

CREATE POLICY "expense_date_locks_admin_write"
  ON public.organization_expense_date_locks FOR ALL
  USING (public.is_org_admin(organization_id))
  WITH CHECK (public.is_org_admin(organization_id));

REVOKE ALL ON public.organization_expense_date_locks FROM PUBLIC;
REVOKE ALL ON public.organization_expense_date_locks FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.organization_expense_date_locks TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Canonical "is this date locked" check -- reused by the trigger AND
--    available to any RPC/report that wants the same answer without
--    re-implementing the range/feature-flag logic.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.is_expense_date_locked_v1(
  p_organization_id uuid,
  p_expense_date date
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Reuses the existing, already-proven feature-flag check (same
    -- function cashier_accountant_mode already relies on) rather than a
    -- second, parallel way to ask "is this feature on for this org".
    public.get_organization_feature_enabled(p_organization_id, 'expense_date_locking') = true
    AND EXISTS (
      SELECT 1
      FROM public.organization_expense_date_locks l
      WHERE l.organization_id = p_organization_id
        AND l.is_active = true
        AND p_expense_date BETWEEN l.date_from AND l.date_to
    );
$$;

REVOKE ALL ON FUNCTION public.is_expense_date_locked_v1(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_expense_date_locked_v1(uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_expense_date_locked_v1(uuid, date) IS
  'Single source of truth for "is this expense date blocked for this organization right now" -- false immediately if expense_date_locking is OFF for the org, regardless of whether lock rows exist. Used by the expenses-table enforcement trigger below.';

-- ════════════════════════════════════════════════════════════════════════
-- 3. Server-side enforcement trigger on public.expenses
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trg_enforce_expense_date_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.trip_start IS NULL OR NEW.organization_id IS NULL THEN
    RETURN NEW; -- malformed row; a separate NOT NULL constraint already rejects this
  END IF;

  -- The business event this lock governs is "a new submission happened",
  -- not "a row was written". That is true only when the row IS submitted
  -- as of this write (NEW.status = 'submitted') AND this write is what
  -- made that so: a fresh INSERT already at 'submitted' (admin-submit-for-
  -- employee, MicroLink's atomic path), a transition INTO 'submitted' from
  -- draft/rejected/edited (the normal two-step create-then-submit flow, and
  -- resubmission), or a trip_start change on an already-submitted row. A
  -- non-submitted INSERT (draft, or any other status) never reaches this
  -- check at all, regardless of trip_start -- see this file's own header
  -- comment for the full write-path audit this is derived from.
  IF NEW.status = 'submitted' AND (
       TG_OP = 'INSERT'
       OR OLD.status IS DISTINCT FROM NEW.status
       OR OLD.trip_start IS DISTINCT FROM NEW.trip_start
     )
  THEN
    IF public.is_expense_date_locked_v1(NEW.organization_id, NEW.trip_start) THEN
      RAISE EXCEPTION
        'This expense date is closed for submission.'
        USING ERRCODE = 'PW010',
              DETAIL = 'EXPENSE_DATE_LOCKED',
              HINT = 'An organization admin has locked this date range for new submissions; existing, already-submitted expenses in that range are unaffected.';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS enforce_expense_date_lock ON public.expenses;

CREATE TRIGGER enforce_expense_date_lock
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_expense_date_lock();

COMMENT ON FUNCTION public.trg_enforce_expense_date_lock() IS
  'Backstop for admin-controlled expense date locking -- fires only when a write results in NEW.status = ''submitted'' AND this write is what made that true (a fresh submitted INSERT, a transition into submitted, or a trip_start change while already submitted), regardless of which client/RPC/path performed the write. A non-submitted INSERT (draft, etc.) is never blocked. A frontend date-picker restriction is UX only; this trigger is what actually makes a lock unbypassable (REST, RPC, a stale browser session, or a manual API request all go through this same table). See this file''s own header comment for the full write-path audit.';

-- ════════════════════════════════════════════════════════════════════════
-- 4. Admin-facing mutation RPCs (explicit is_org_admin re-check, defense in
--    depth alongside the RLS policy above)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_expense_date_lock_v1(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date,
  p_reason text DEFAULT NULL
)
RETURNS public.organization_expense_date_locks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.organization_expense_date_locks%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_org_admin(p_organization_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL THEN
    RAISE EXCEPTION 'date_from and date_to are both required' USING ERRCODE = '22023';
  END IF;
  IF p_date_from > p_date_to THEN
    RAISE EXCEPTION 'date_from must not be after date_to' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organization_expense_date_locks
    (organization_id, date_from, date_to, reason, is_active, created_by)
  VALUES
    (p_organization_id, p_date_from, p_date_to, NULLIF(btrim(p_reason), ''), true, auth.uid())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_expense_date_lock_v1(uuid, date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_expense_date_lock_v1(uuid, date, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.deactivate_expense_date_lock_v1(
  p_lock_id uuid
)
RETURNS public.organization_expense_date_locks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_org_id uuid;
  v_row public.organization_expense_date_locks%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT organization_id INTO v_org_id
  FROM public.organization_expense_date_locks
  WHERE id = p_lock_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'lock not found' USING ERRCODE = 'P0002';
  END IF;
  -- Derives the organization from the row itself, then checks admin-of-
  -- THAT-organization -- an admin of a different org can never reach this
  -- far regardless of what lock id they pass in.
  IF NOT public.is_org_admin(v_org_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;

  UPDATE public.organization_expense_date_locks
  SET is_active = false, updated_at = now()
  WHERE id = p_lock_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.deactivate_expense_date_lock_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_expense_date_lock_v1(uuid) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Verification
-- ════════════════════════════════════════════════════════════════════════
DO $verify$
BEGIN
  IF to_regclass('public.organization_expense_date_locks') IS NULL THEN
    RAISE EXCEPTION 'organization_expense_date_locks table was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_expense_date_lock' AND tgrelid = 'public.expenses'::regclass
  ) THEN
    RAISE EXCEPTION 'enforce_expense_date_lock trigger was not installed on public.expenses';
  END IF;
  RAISE NOTICE 'expense_date_locking_v1 migration verified OK';
END;
$verify$;
