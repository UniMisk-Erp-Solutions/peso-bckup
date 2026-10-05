-- ─────────────────────────────────────────────────────────────────────────────
-- PesoWise · Expense Recycle Bin — 30-day soft delete (DOC-129)
--
-- WHY
-- ===
-- DOC-128 (20260922090000) correctly made delete_draft_expense_v1 refuse to
-- permanently erase a draft that was ever submitted (withdrawn), to protect
-- its audit history. That is the right rule for a PERMANENT delete, but it
-- left withdrawn employees with no way to remove the expense from their
-- active list at all -- "Delete" on a withdrawn draft always fails with
-- "This expense was previously submitted and withdrawn... cannot be
-- permanently deleted."
--
-- This migration turns "Delete" into a 30-day soft delete (a Recycle Bin)
-- instead of an immediate physical delete. Nothing about DOC-128's actual
-- protection is weakened: a withdrawn expense's audit history is still never
-- erased while it matters, and financially-posted expenses (approved,
-- level_1_verified, level_2_verified, paid, or anything with a balance
-- deduction) still cannot be trashed by an ordinary employee at all -- only
-- a genuine 'draft' (never-submitted OR withdrawn-back-to-draft) is
-- eligible, exactly the same status gate delete_draft_expense_v1 already
-- used, just without its stricter "never submitted" sub-condition.
--
-- DATA MODEL (Part C/D)
-- ======================
-- expenses.deleted_at / deleted_by / purge_after -- nullable, additive.
-- No new workflow status. `status` and "is this trashed" are deliberately
-- orthogonal: a trashed draft is still status='draft', just with
-- deleted_at set. This avoids touching every reviewer/approval/reporting
-- query that already switches on `status`, and avoids reinterpreting
-- history: `expense_status_transition_allowed_v1`/`_expense_status_is_
-- protected_v1` (DOC-122) need zero changes.
--   deleted_at IS NULL                                -> active
--   deleted_at IS NOT NULL AND purge_after > now()     -> in the Recycle Bin
--   deleted_at IS NOT NULL AND purge_after <= now()    -> eligible for purge
-- Existing rows: ADD COLUMN with no default leaves every existing row
-- deleted_at = NULL (active) -- a metadata-only change, no table rewrite,
-- no business row touched.
--
-- RPCs (Parts E, L, N)
-- =====================
--   trash_expense_v1             -- owner-only, draft-only, atomic soft delete
--   restore_trashed_expense_v1   -- owner-only, within retention, back to draft
--   purge_expired_trashed_expenses_v1 -- service_role-only, the daily job
-- list_trashed_expenses_v1 (Part J) is deliberately a thin SECURITY INVOKER
-- wrapper over the ALREADY-PROVEN owner/admin SELECT RLS on `expenses`
-- ("Users can view their own expenses", "Admins can view all expenses",
-- "Org admins can view organization expenses") -- it does not need
-- SECURITY DEFINER or any new privilege, because a trashed row's owner and
-- org admins can already read it today (no existing SELECT policy filters
-- status or, until now, deleted_at); this migration's real access-control
-- work is entirely in the two mutating RPCs and the tombstone table.
--
-- WHY NO NEW RLS SELECT/UPDATE POLICY IS NEEDED FOR deleted_at ITSELF
-- ====================================================================
-- Checked live (see the Phase 6-style preflight this migration's own
-- companion QA harness runs): there has never been an owner UPDATE policy
-- for a DRAFT row at all except "Users can submit their draft expenses"
-- (USING status='draft', WITH CHECK status='submitted' -- the one-way
-- draft->submitted door). Editing a draft's own fields, and now trashing/
-- restoring one, has therefore never been possible via a raw client UPDATE
-- -- it already requires a SECURITY DEFINER RPC. deleted_at/deleted_by/
-- purge_after inherit that same closed door for free; this migration does
-- not add or loosen a single UPDATE policy.
--
-- WHY "ACTIVE" READS NEED A CODE CHANGE, NOT AN RLS CHANGE (Part K)
-- ====================================================================
-- The existing SELECT policies ("Users can view their own expenses" etc.)
-- were never status-filtered either, so they will keep returning a trashed
-- row exactly as before -- RLS is a security boundary, not the product's
-- "what counts as active" boundary, and widening/narrowing it here would
-- touch every feature that reads `expenses`, most of which this migration
-- has not audited. Precise `deleted_at IS NULL` filters are added instead,
-- one at a time, only to the specific active-list contracts inventoried and
-- fixed in this same change (My Expenses' RPC and client fetch, the review
-- queue, batch review) -- see the accompanying frontend/RPC diff for the
-- exact list. Historical/accounting reports are deliberately left alone.
--
-- TOMBSTONE (Part O)
-- ===================
-- purged_expense_tombstones has NO foreign key to `expenses` (the row it
-- describes is gone once the tombstone is written) -- every FK from a child
-- table onto `expenses` in this schema is ON DELETE CASCADE (checked live:
-- attachments, audit_logs, expense_balance_deductions, expense_correction_
-- logs, expense_form_field_value_history, expense_form_field_values,
-- expense_line_items, expense_submission_receipts, notifications,
-- supervisor_reassignment_repair_log, admin_submit_expense_idempotency),
-- so an audit_logs row referencing the expense would itself be deleted the
-- instant the expense row is -- a durable record must live outside that
-- blast radius. Only the minimal identifying fields are kept.
--
-- Production DML: 0. Production DDL: 0 in this session -- applying this
-- file is a manual step, per this repo's convention.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. SCHEMA — additive columns + supporting indexes
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS deleted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by  uuid,
  ADD COLUMN IF NOT EXISTS purge_after timestamptz;

COMMENT ON COLUMN public.expenses.deleted_at IS
  'Soft-delete marker (Recycle Bin). NULL = active. Set only by trash_expense_v1 / cleared only by restore_trashed_expense_v1 / the row itself removed only by purge_expired_trashed_expenses_v1. Orthogonal to `status` -- never becomes a workflow status.';
COMMENT ON COLUMN public.expenses.deleted_by IS 'auth.uid() of whoever trashed it.';
COMMENT ON COLUMN public.expenses.purge_after IS 'deleted_at + 30 days. Restorable while purge_after > now(); eligible for permanent purge once passed.';

-- Recycle-bin listing (an owner's or org's trashed rows) and the daily purge
-- scan both filter on deleted_at IS NOT NULL; partial indexes keep both
-- queries cheap without bloating the far more common active-row scans.
CREATE INDEX IF NOT EXISTS idx_expenses_trashed_by_org
  ON public.expenses (organization_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_trashed_by_user
  ON public.expenses (user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_purge_due
  ON public.expenses (purge_after)
  WHERE deleted_at IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. TOMBSTONE TABLE — the only durable record of a purged expense
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.purged_expense_tombstones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id            uuid NOT NULL,           -- deliberately no FK; the row is gone
  transaction_number    text,
  organization_id       uuid,
  user_id               uuid,
  deleted_by            uuid,
  trashed_at            timestamptz NOT NULL,
  purged_at             timestamptz NOT NULL DEFAULT now(),
  -- Storage objects can't be deleted inside the same transaction as the DB
  -- purge (they live outside Postgres). Recording the paths here, with a
  -- done flag, lets the daily purge script retry Storage cleanup on a later
  -- run without ever needing to re-derive them from a row that no longer
  -- exists -- the "DB deleted, storage half-failed, no recovery" case
  -- Part N explicitly warns against.
  attachment_paths      jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_cleanup_done  boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.purged_expense_tombstones IS
  'Minimal durable record of a permanently-purged (30-day-expired) Recycle Bin expense. No FK to expenses -- the row no longer exists by the time this is written. Written only by purge_expired_trashed_expenses_v1. attachment_paths/storage_cleanup_done let the purge script retry best-effort Storage deletion on a later run.';

ALTER TABLE public.purged_expense_tombstones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins can view their organization's purge tombstones" ON public.purged_expense_tombstones;

CREATE POLICY "Org admins can view their organization's purge tombstones"
ON public.purged_expense_tombstones FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid() AND om.organization_id = purged_expense_tombstones.organization_id
      AND om.role = 'admin'::app_role AND om.is_active = true
  )
);

REVOKE ALL ON public.purged_expense_tombstones FROM PUBLIC;
REVOKE ALL ON public.purged_expense_tombstones FROM anon;
GRANT SELECT ON public.purged_expense_tombstones TO authenticated;

-- The daily purge script marks a tombstone's Storage cleanup done once the
-- Storage API deletion actually succeeds; nothing else should ever write
-- to this table, so only that one column transition is allowed.
CREATE OR REPLACE FUNCTION public.mark_tombstone_storage_cleaned_v1(p_tombstone_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.purged_expense_tombstones
  SET storage_cleanup_done = true
  WHERE id = p_tombstone_id;
$$;

REVOKE ALL ON FUNCTION public.mark_tombstone_storage_cleaned_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_tombstone_storage_cleaned_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.mark_tombstone_storage_cleaned_v1(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tombstone_storage_cleaned_v1(uuid) TO service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. TRASH — soft-delete a draft (never-submitted OR withdrawn) expense
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trash_expense_v1(
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e     public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Lock first, same ordering every mutating expense RPC in this schema
  -- uses, so a concurrent submit/withdraw/approve/trash can never race.
  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
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

  -- Idempotent: already in the bin is a successful outcome, not an error.
  IF e.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'expense_id', p_expense_id, 'action', 'already_trashed',
      'purge_after', e.purge_after
    );
  END IF;

  -- The one eligibility rule: only a DRAFT (never-submitted or withdrawn
  -- back to draft) may be trashed. Submitted must be withdrawn first
  -- (Withdraw and Delete are never combined silently); anything financially
  -- posted or reviewed is never reachable via this path at all.
  IF e.status <> 'draft' THEN
    RAISE EXCEPTION
      'Only a draft expense can be moved to the Recycle Bin (current status: %). A submitted expense can be withdrawn first.',
      e.status;
  END IF;

  IF EXISTS (SELECT 1 FROM public.expense_balance_deductions d WHERE d.expense_id = p_expense_id) THEN
    RAISE EXCEPTION 'This expense already has a balance deduction on record; it cannot be deleted. This needs manual review.';
  END IF;

  UPDATE public.expenses
  SET deleted_at = now(), deleted_by = v_uid, purge_after = now() + interval '30 days'
  WHERE id = p_expense_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This expense changed while moving it to the Recycle Bin. Please refresh and try again.';
  END IF;

  INSERT INTO public.audit_logs (organization_id, expense_id, user_id, action, comment)
  VALUES (
    e.organization_id, p_expense_id, v_uid, 'expense_trashed',
    'Moved to Recycle Bin by owner. Restorable for 30 days; automatically purged after.'
  );

  RETURN jsonb_build_object(
    'ok', true, 'expense_id', p_expense_id, 'action', 'trashed',
    'purge_after', now() + interval '30 days'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trash_expense_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trash_expense_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.trash_expense_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.trash_expense_v1(uuid) IS
  'Soft-deletes the caller''s own draft expense (30-day Recycle Bin). Never-submitted or previously-submitted-and-withdrawn drafts are both eligible; anything else must be withdrawn first. Idempotent; writes an expense_trashed audit_logs row; balance/deductions/receipts/history all untouched.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. RESTORE — bring a trashed expense back, always as a draft
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.restore_trashed_expense_v1(
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  e     public.expenses%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO e FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF e.user_id <> v_uid THEN
    RAISE EXCEPTION 'You don''t have permission to restore this expense';
  END IF;

  IF e.organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = e.organization_id AND om.is_active = true
  ) THEN
    RAISE EXCEPTION 'You are not an active member of this expense''s organization';
  END IF;

  IF e.deleted_at IS NULL THEN
    RAISE EXCEPTION 'This expense is not in the Recycle Bin';
  END IF;

  IF e.purge_after <= now() THEN
    RAISE EXCEPTION 'The 30-day retention period for this expense has expired; it can no longer be restored.';
  END IF;

  -- Race safety against a concurrent purge: the purge job takes the same
  -- row lock and rechecks deleted_at/purge_after itself, so whichever of
  -- restore/purge acquires the lock first wins and the other's own
  -- precondition (deleted_at IS NOT NULL here, or "still expired" there)
  -- fails cleanly against the now-current row.
  UPDATE public.expenses
  SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL
  WHERE id = p_expense_id AND deleted_at IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This expense changed while restoring it. Please refresh and try again.';
  END IF;

  INSERT INTO public.audit_logs (organization_id, expense_id, user_id, action, comment)
  VALUES (
    e.organization_id, p_expense_id, v_uid, 'expense_restored',
    'Restored from Recycle Bin by owner. Returned as a draft; must be explicitly resubmitted.'
  );

  RETURN jsonb_build_object(
    'ok', true, 'expense_id', p_expense_id, 'action', 'restored', 'status', 'draft'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.restore_trashed_expense_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_trashed_expense_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.restore_trashed_expense_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.restore_trashed_expense_v1(uuid) IS
  'Restores the caller''s own trashed expense while still within its 30-day retention window. Always returns as draft -- never resubmits or re-enters review automatically. Writes an expense_restored audit_logs row.';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. LIST — the caller's (or, for an org admin, their org's) trashed expenses
-- ══════════════════════════════════════════════════════════════════════════
-- Deliberately SECURITY INVOKER (the default): relies entirely on the
-- ALREADY-LIVE owner/admin SELECT RLS on `expenses` ("Users can view their
-- own expenses", "Admins can view all expenses", "Org admins can view
-- organization expenses") -- no new privilege is created, and a cross-org
-- row is structurally unreachable the same way it already is today.
CREATE OR REPLACE FUNCTION public.list_trashed_expenses_v1(
  p_organization_id uuid
)
RETURNS TABLE (
  id                 uuid,
  transaction_number text,
  title              text,
  destination        text,
  trip_start         date,
  total_amount       numeric,
  status_before       text,
  deleted_at         timestamptz,
  purge_after        timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT e.id, e.transaction_number, e.title, e.destination, e.trip_start, e.total_amount,
         e.status::text AS status_before, e.deleted_at, e.purge_after
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.deleted_at IS NOT NULL
    AND e.purge_after > now()
  ORDER BY e.deleted_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_trashed_expenses_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_trashed_expenses_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_trashed_expenses_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_trashed_expenses_v1(uuid) IS
  'Lists not-yet-expired Recycle Bin expenses in the given organization, scoped by the caller''s own existing expenses SELECT RLS (owner sees their own; org admin sees the organization''s). SECURITY INVOKER by design -- no new privilege.';

-- ══════════════════════════════════════════════════════════════════════════
-- 6. PURGE — the daily job. service_role only; never callable by a client.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.purge_expired_trashed_expenses_v1()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r                public.expenses%ROWTYPE;
  v_paths          text[];
  v_purged_count   int := 0;
  v_skipped_count  int := 0;
  v_tombstone_ids  uuid[] := ARRAY[]::uuid[];
  v_attachment_paths jsonb := '[]'::jsonb;
  v_tombstone_id   uuid;
BEGIN
  -- SKIP LOCKED: never block behind a row a concurrent restore is touching;
  -- pick it up on tomorrow's run instead if it's still eligible then.
  FOR r IN
    SELECT * FROM public.expenses
    WHERE deleted_at IS NOT NULL AND purge_after <= now()
    ORDER BY purge_after
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Recheck everything against the now-locked, current row -- never trust
    -- the snapshot the outer SELECT read before locking.
    IF r.deleted_at IS NULL OR r.purge_after > now() THEN
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.expense_balance_deductions d WHERE d.expense_id = r.id) THEN
      -- Structurally should be impossible (only drafts are ever trashed),
      -- but a financial-integrity incident must skip this row, not purge
      -- it, and needs manual review.
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

    SELECT array_remove(array_agg(a.storage_path), NULL) INTO v_paths
    FROM public.attachments a WHERE a.expense_id = r.id;

    INSERT INTO public.purged_expense_tombstones
      (expense_id, transaction_number, organization_id, user_id, deleted_by, trashed_at, attachment_paths)
    VALUES (
      r.id, r.transaction_number, r.organization_id, r.user_id, r.deleted_by, r.deleted_at,
      to_jsonb(COALESCE(v_paths, ARRAY[]::text[]))
    )
    RETURNING id INTO v_tombstone_id;

    -- Cascades attachments/audit_logs/expense_balance_deductions/
    -- expense_correction_logs/expense_form_field_value_history/
    -- expense_form_field_values/expense_line_items/expense_submission_
    -- receipts/notifications/supervisor_reassignment_repair_log (all
    -- ON DELETE CASCADE, confirmed live) -- no manual child deletes needed.
    DELETE FROM public.expenses WHERE id = r.id;

    v_purged_count := v_purged_count + 1;
    v_tombstone_ids := array_append(v_tombstone_ids, v_tombstone_id);
    IF v_paths IS NOT NULL AND array_length(v_paths, 1) > 0 THEN
      v_attachment_paths := v_attachment_paths || to_jsonb(v_paths);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'purged_count', v_purged_count, 'skipped_count', v_skipped_count,
    'tombstone_ids', to_jsonb(v_tombstone_ids), 'attachment_paths', v_attachment_paths
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_trashed_expenses_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_trashed_expenses_v1() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_trashed_expenses_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_trashed_expenses_v1() TO service_role;

COMMENT ON FUNCTION public.purge_expired_trashed_expenses_v1() IS
  'Daily job (service_role only, never callable by an ordinary client): permanently deletes every Recycle Bin expense past its 30-day purge_after, after rechecking eligibility per-row under FOR UPDATE SKIP LOCKED. Writes one purged_expense_tombstones row per purge before the cascade-delete removes everything else. Idempotent (a row already gone or already restored is simply not selected). Returns attachment storage paths for the caller''s best-effort Storage cleanup.';

-- ══════════════════════════════════════════════════════════════════════════
-- 7. RETIRE THE OLD HARD-DELETE PATH FOR ORDINARY CLIENTS (Part H)
-- ══════════════════════════════════════════════════════════════════════════
-- delete_draft_expense_v1 (DOC-128) is not dropped -- its dependencies
-- (existing grants, the frontend code this same PR also stops calling it
-- from) are understood, and dropping a function outright is unnecessary
-- risk for zero benefit. Revoking `authenticated`'s EXECUTE is sufficient:
-- an ordinary client can no longer reach a hard-delete bypass of the
-- Recycle Bin at all (PostgREST will refuse the call the same way it
-- already refuses `anon` -- confirmed live for that role in DOC-128's own
-- QA), while the function itself remains available to a service_role
-- caller if ever needed for an internal maintenance task. It is not used by
-- purge_expired_trashed_expenses_v1 above, which does its own delete
-- directly (a draft with no submission history should now go to the
-- Recycle Bin like everything else, not be hard-deleted on a different
-- schedule).
REVOKE EXECUTE ON FUNCTION public.delete_draft_expense_v1(uuid) FROM authenticated;

COMMENT ON FUNCTION public.delete_draft_expense_v1(uuid) IS
  'Superseded by trash_expense_v1 (DOC-129 Recycle Bin) for ordinary client use as of 20260922120000 -- EXECUTE revoked from authenticated. Retained, unused, for any future internal/service_role-only maintenance need; not dropped because its dependencies were not re-audited for removal.';

-- ══════════════════════════════════════════════════════════════════════════
-- 8. ACTIVE-FACING READS — exclude trashed rows from the highest-traffic,
--    explicitly-in-scope "what's currently active" contracts (Part K)
-- ══════════════════════════════════════════════════════════════════════════
-- A full-codebase inventory of every query reading `expenses` was done
-- before writing this section (see DOC-129's own doc for the complete
-- table). Deliberately NOT touched here: historical/accounting reports
-- (report_balance_timeline_rows_v3 -- the Detailed Expense ledger, keyed off
-- expense_balance_deductions, not live status; report_expense_rows_v1 --
-- Claim Verification/Approval snapshot exports), and several dashboard/
-- history views flagged as needing an explicit owner decision rather than a
-- guess (My Teams' approved-tile, Daily Project Report, Analytics trends,
-- Old Money's trend chart, Admin Submission History, the UserManagement
-- per-employee drill-down). Widening this list is a fast follow-up once the
-- owner confirms each one's intent -- adding `deleted_at IS NULL` to any of
-- them later needs no schema change, only another CREATE OR REPLACE here.
--
-- Each function below is reproduced byte-for-byte from its live definition
-- (captured immediately before writing this migration) with exactly one
-- line added -- never re-derived from the original migration file, so nothing
-- else about behaviour, formatting or a prior bug fix can silently drift.

-- 8a. get_my_expenses_page_v1 (20260915120000) — My Expenses page, both the
--     scoped-ids population and the base filtered-id set.
CREATE OR REPLACE FUNCTION public.get_my_expenses_page_v1(p_organization_id uuid, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_sort_by text DEFAULT 'trip_start'::text, p_sort_order text DEFAULT 'desc'::text, p_date_from date DEFAULT NULL::date, p_date_to_exclusive date DEFAULT NULL::date, p_custom_filters jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_page        integer := GREATEST(1, COALESCE(p_page, 1));
  v_page_size   integer := LEAST(100, GREATEST(1, COALESCE(p_page_size, 25)));
  v_offset      integer;
  v_total       integer := 0;
  v_total_pages integer := 0;
  v_matched_ids uuid[];
  v_ids         uuid[];
  v_items       jsonb := '[]'::jsonb;
  v_order_sql   text;
  v_order_col   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active
  ) THEN
    RAISE EXCEPTION 'This expense endpoint is not available for your organization.'
      USING ERRCODE = '42501';
  END IF;

  IF p_sort_by NOT IN ('title', 'destination', 'total_amount', 'trip_start', 'created_at') THEN
    RAISE EXCEPTION 'invalid sort_by %', p_sort_by USING ERRCODE = '22023';
  END IF;
  IF p_sort_order NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'invalid sort_order %', p_sort_order USING ERRCODE = '22023';
  END IF;

  v_offset := (v_page - 1) * v_page_size;

  -- Canonical custom-field map computed ONCE for this user's own expenses
  -- (scoped_ids), then reused for BOTH the search haystack and the
  -- custom-field filter predicate -- the fix for §5/§6: a filter or a search
  -- word can now only ever match through the SAME visible (template-wins)
  -- value that the response's own `custom_fields` will display, never
  -- through a hidden losing branch value.
  WITH scoped_ids AS (
    SELECT e.id
    FROM public.expenses e
    WHERE e.organization_id = p_organization_id
      AND e.user_id = v_uid
      AND e.deleted_at IS NULL -- DOC-129: a trashed expense is never part of "My Expenses"
  ),
  canonical_cf AS (
    SELECT * FROM public._my_expenses_canonical_custom_fields_v1(
      (SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) FROM scoped_ids)
    )
  ),
  custom_search AS (
    SELECT
      expense_id,
      lower(string_agg(label || ' ' || value, ' ')) AS haystack
    FROM canonical_cf
    GROUP BY expense_id
  ),
  -- Step 1a (static, fully parameterized): every id matching status/date/
  -- search, unordered.
  base AS (
    SELECT e.id
    FROM public.expenses e
    LEFT JOIN custom_search cs ON cs.expense_id = e.id
    WHERE e.organization_id = p_organization_id
      AND e.user_id = v_uid
      AND e.deleted_at IS NULL -- DOC-129
      AND (p_status IS NULL OR p_status = 'all' OR e.status::text = p_status)
      AND (p_date_from IS NULL OR e.trip_start >= p_date_from)
      AND (p_date_to_exclusive IS NULL OR e.trip_start < p_date_to_exclusive)
      AND (
        p_search IS NULL OR btrim(p_search) = ''
        -- Every whitespace-split word of the (lowercased) search term must be
        -- found in AT LEAST ONE of these fields -- not necessarily the same
        -- field for every word (§5-9 cross-field multi-word matching). Using
        -- NOT EXISTS(word that fails everywhere) is the SQL mirror of the
        -- client's `words.every(word => haystack.includes(word))`.
        OR NOT EXISTS (
          SELECT 1
          FROM regexp_split_to_table(lower(btrim(p_search)), '\s+') AS w(word)
          WHERE w.word <> ''
            AND strpos(lower(e.title), w.word) = 0
            AND strpos(lower(e.destination), w.word) = 0
            AND strpos(lower(COALESCE(e.purpose, '')), w.word) = 0
            AND strpos(lower(COALESCE(e.category, '')), w.word) = 0
            AND strpos(lower(e.status::text), w.word) = 0
            AND strpos(lower(COALESCE(e.transaction_number::text, '')), w.word) = 0
            AND strpos(lower(e.total_amount::text), w.word) = 0
            AND strpos(COALESCE(cs.haystack, ''), w.word) = 0
        )
      )
  )
  -- Step 1b: AND the custom-field {label, value} filters together, each
  -- checked against the SAME canonical_cf map used for search and for the
  -- final display -- one source of truth, not a separate raw-row check.
  SELECT array_agg(b.id)
  INTO v_matched_ids
  FROM base b
  WHERE (
    p_custom_filters IS NULL
    OR jsonb_array_length(p_custom_filters) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_custom_filters) AS cf(label text, value text)
      WHERE NOT EXISTS (
        SELECT 1
        FROM canonical_cf cm
        WHERE cm.expense_id = b.id
          AND cm.label = cf.label
          AND cm.value = cf.value
      )
    )
  );

  v_matched_ids := COALESCE(v_matched_ids, ARRAY[]::uuid[]);
  v_total := array_length(v_matched_ids, 1);
  IF v_total IS NULL THEN v_total := 0; END IF;
  v_total_pages := CASE WHEN v_total > 0 THEN CEIL(v_total::numeric / v_page_size::numeric)::integer ELSE 0 END;

  -- Step 2: page this SET of ids. title/destination sort case-insensitively
  -- (matching the client's .toLowerCase() sort, §12-13); every sort has a
  -- stable `id` tiebreaker so paging never duplicates or skips a row. %s
  -- inlines p_sort_order and the column expression -- both already validated
  -- above against a hardcoded whitelist, so no client-supplied text ever
  -- reaches this format() call.
  IF v_total > 0 THEN
    v_order_col := CASE
      WHEN p_sort_by IN ('title', 'destination') THEN format('lower(e.%I)', p_sort_by)
      ELSE format('e.%I', p_sort_by)
    END;
    v_order_sql := format(
      'SELECT array_agg(x.id) FROM (SELECT e.id FROM public.expenses e WHERE e.id = ANY($1) ORDER BY %s %s, e.id %s LIMIT $2 OFFSET $3) x',
      v_order_col, p_sort_order, p_sort_order
    );
    EXECUTE v_order_sql INTO v_ids USING v_matched_ids, v_page_size, v_offset;
  END IF;
  v_ids := COALESCE(v_ids, ARRAY[]::uuid[]);

  -- Enrich exactly this page's rows (never the whole filtered population) by
  -- reusing the SAME already-live enrichment RPCs the client calls today,
  -- and the SAME canonical custom-field helper used above (re-scoped to just
  -- this page's ids -- a fresh call, since plpgsql CTEs don't span statements,
  -- but textually the identical shared function, so the precedence rule can
  -- never drift between what matched the filter/search and what is shown).
  WITH resub AS (
    SELECT expense_id FROM public.get_resubmitted_expense_ids(v_ids) AS t(expense_id)
  ),
  corrected AS (
    SELECT expense_id FROM public.get_reviewer_corrected_expense_ids(v_ids, p_organization_id) AS t(expense_id)
  ),
  page_canonical_cf AS (
    SELECT * FROM public._my_expenses_canonical_custom_fields_v1(v_ids)
  ),
  custom_map AS (
    SELECT expense_id, jsonb_object_agg(label, value) AS fields
    FROM page_canonical_cf
    GROUP BY expense_id
  ),
  ordered_ids AS (
    SELECT id, ord FROM unnest(v_ids) WITH ORDINALITY AS u(id, ord)
  )
  SELECT COALESCE(jsonb_agg(row_json ORDER BY oi.ord), '[]'::jsonb)
  INTO v_items
  FROM ordered_ids oi
  JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', e.id,
      'user_id', e.user_id,
      'title', e.title,
      'destination', e.destination,
      'trip_start', e.trip_start,
      'trip_end', e.trip_end,
      'status', e.status::text,
      'total_amount', e.total_amount,
      'created_at', e.created_at,
      'transaction_number', e.transaction_number,
      'purpose', e.purpose,
      'category', e.category,
      'isResubmitted', EXISTS (SELECT 1 FROM resub r WHERE r.expense_id = e.id),
      'wasReviewerCorrected', EXISTS (SELECT 1 FROM corrected c WHERE c.expense_id = e.id),
      'custom_fields', COALESCE((SELECT cm.fields FROM custom_map cm WHERE cm.expense_id = e.id), '{}'::jsonb)
    ) AS row_json
    FROM public.expenses e
    WHERE e.id = oi.id
  ) x ON true;

  RETURN jsonb_build_object(
    'items', v_items,
    'filtered_total', v_total,
    'total_pages', v_total_pages,
    'page', v_page,
    'page_size', v_page_size
  );
END;
$function$;

-- 8b/8c. count_reviewer_visible_expenses / list_reviewer_visible_expenses_page
--        (20260731090000) — the live Review Expenses reviewer queue.
CREATE OR REPLACE FUNCTION public.count_reviewer_visible_expenses(p_organization_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COUNT(*)::bigint
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.deleted_at IS NULL -- DOC-129: trashed expenses are never reviewer-actionable
    AND e.status IN ('submitted','verified','approved','rejected','edited',
                     'under_review','level_1_verified','level_2_verified')
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.organization_id = p_organization_id
        AND om.is_active = true
    )
    AND (
      e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids(p_organization_id) v)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.audit_logs al
        WHERE al.expense_id = e.id AND al.organization_id = p_organization_id
          AND al.user_id = auth.uid()
          AND al.action IN ('expense_verified','expense_approved','tier_advanced','expense_rejected')
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.list_reviewer_visible_expenses_page(p_organization_id uuid, p_after_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_page_size integer DEFAULT 250)
RETURNS SETOF expenses
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.deleted_at IS NULL -- DOC-129
    AND e.status IN ('submitted','verified','approved','rejected','edited',
                     'under_review','level_1_verified','level_2_verified')
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid() AND om.organization_id = p_organization_id
        AND om.is_active = true
    )
    AND (
      e.user_id IN (SELECT v.user_id FROM public.reviewer_visible_user_ids(p_organization_id) v)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.audit_logs al
        WHERE al.expense_id = e.id AND al.organization_id = p_organization_id
          AND al.user_id = auth.uid()
          AND al.action IN ('expense_verified','expense_approved','tier_advanced','expense_rejected')
      )
    )
    AND (
      p_after_updated_at IS NULL
      OR COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) < p_after_updated_at
      OR (
        COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) = p_after_updated_at
        AND (p_after_id IS NULL OR e.id < p_after_id)
      )
    )
  ORDER BY COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 1000);
$function$;

-- 8d. get_dashboard_expense_summary (20260529140000) — dashboard KPI tiles,
--     including the headline "pending approvals" badge.
CREATE OR REPLACE FUNCTION public.get_dashboard_expense_summary(p_organization_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'total_amount', COALESCE(SUM(e.total_amount), 0),
    'pending_amount', COALESCE(
      SUM(e.total_amount) FILTER (WHERE e.status IN ('submitted', 'verified')),
      0
    ),
    'approved_amount', COALESCE(
      SUM(e.total_amount) FILTER (WHERE e.status = 'approved'),
      0
    ),
    'expense_count', COUNT(*)::bigint,
    'pending_approvals', COUNT(*) FILTER (
      WHERE e.status = 'verified'
        OR (e.status = 'submitted' AND e.assigned_engineer_id IS NULL)
    )::bigint,
    'pending_approvals_amount', COALESCE(
      SUM(e.total_amount) FILTER (
        WHERE e.status = 'verified'
          OR (e.status = 'submitted' AND e.assigned_engineer_id IS NULL)
      ),
      0
    )
  )
  FROM public.expenses e
  WHERE (p_organization_id IS NULL OR e.organization_id = p_organization_id)
    AND (p_user_id IS NULL OR e.user_id = p_user_id)
    AND e.deleted_at IS NULL; -- DOC-129
$function$;

-- 8e. withdraw_submitted_expense_v1 (20260922090000, DOC-128) — its "no
--     review activity on record" defense-in-depth check enumerates an
--     allow-list of expected audit_logs actions that predates this
--     migration's two new ones. Found during this migration's own QA: an
--     expense that had ever been trashed-then-restored (a legitimate,
--     ordinary Recycle Bin cycle, not a review action) could no longer be
--     withdrawn afterwards -- withdraw would wrongly report "review
--     activity on record" and refuse. Reproduced byte-for-byte from the
--     live DOC-128 definition with only the allow-list widened; every other
--     line, including all of DOC-128's own safety checks, is untouched.
CREATE OR REPLACE FUNCTION public.withdraw_submitted_expense_v1(p_expense_id uuid, p_comment text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    AND a.action NOT IN ('expense_created', 'expense_submitted', 'expense_withdrawn', 'expense_updated', 'expense_trashed', 'expense_restored');
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
$function$;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. INSTALL-TIME PROOF — the migration must not change a single business row
-- ══════════════════════════════════════════════════════════════════════════
DO $verify$
BEGIN
  IF to_regprocedure('public.trash_expense_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'trash_expense_v1 was not installed';
  END IF;
  IF to_regprocedure('public.restore_trashed_expense_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'restore_trashed_expense_v1 was not installed';
  END IF;
  IF to_regprocedure('public.list_trashed_expenses_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'list_trashed_expenses_v1 was not installed';
  END IF;
  IF to_regprocedure('public.purge_expired_trashed_expenses_v1()') IS NULL THEN
    RAISE EXCEPTION 'purge_expired_trashed_expenses_v1 was not installed';
  END IF;
  IF to_regprocedure('public.mark_tombstone_storage_cleaned_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'mark_tombstone_storage_cleaned_v1 was not installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='expenses' AND column_name='deleted_at'
  ) THEN
    RAISE EXCEPTION 'expenses.deleted_at column was not added';
  END IF;
  IF EXISTS (SELECT 1 FROM public.expenses WHERE deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'rule regression: a pre-existing row was marked deleted by this migration -- it must add columns only';
  END IF;
  IF has_function_privilege('authenticated', 'public.delete_draft_expense_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'delete_draft_expense_v1 must no longer be callable by authenticated -- Recycle Bin bypass still open';
  END IF;
  IF pg_get_functiondef('public.get_my_expenses_page_v1(uuid,integer,integer,text,text,text,text,date,date,jsonb)'::regprocedure) NOT ILIKE '%e.deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'get_my_expenses_page_v1 does not exclude trashed rows';
  END IF;
  IF pg_get_functiondef('public.count_reviewer_visible_expenses(uuid)'::regprocedure) NOT ILIKE '%e.deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'count_reviewer_visible_expenses does not exclude trashed rows';
  END IF;
  IF pg_get_functiondef('public.list_reviewer_visible_expenses_page(uuid,timestamptz,uuid,integer)'::regprocedure) NOT ILIKE '%e.deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'list_reviewer_visible_expenses_page does not exclude trashed rows';
  END IF;
  IF pg_get_functiondef('public.get_dashboard_expense_summary(uuid,uuid)'::regprocedure) NOT ILIKE '%e.deleted_at IS NULL%' THEN
    RAISE EXCEPTION 'get_dashboard_expense_summary does not exclude trashed rows';
  END IF;
  IF pg_get_functiondef('public.withdraw_submitted_expense_v1(uuid,text)'::regprocedure) NOT ILIKE '%expense_trashed%expense_restored%' THEN
    RAISE EXCEPTION 'withdraw_submitted_expense_v1 was not updated to allow a prior trash/restore cycle';
  END IF;
END
$verify$;

COMMIT;
