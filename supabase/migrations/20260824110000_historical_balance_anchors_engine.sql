-- Historical Balance Anchors V2 -- replay engine + public RPCs.
--
-- Core formula (see 20260824100000's header for the full rationale):
--
--   materialized_delta(anchor) = anchor.stated_balance
--                               - reconstructed_balance_immediately_before(anchor)
--
-- reconstructed_balance_immediately_before(anchor) sums, strictly before the
-- anchor's timeline position (effective_date, day_position, sequence_number):
--   * every OTHER active anchor's CURRENT materialized_delta, plus
--   * every ordinary balance_ledger delta (excluding the four
--     historical-anchor entry_types, to avoid double counting), plus
--   * every expense_balance_deductions delta (a separate evidence table,
--     never mirrored into balance_ledger -- see get_my_unified_balance_history_v1).
--
-- profiles.balance is changed ONLY by the NET change in an anchor's own
-- materialized_delta (new minus old, old=0 the first time), never by
-- "set balance = stated_balance" and never by re-deriving the whole balance
-- from scratch. Editing/reversing an anchor cascades this same net-change
-- calculation, in ascending timeline order, to every downstream active
-- anchor for that employee -- each one's own materialized_delta shifts only
-- because the position immediately before IT changed, not because anyone
-- touched it directly. This is what makes a later Balance Update
-- "re-establish the truth" regardless of an earlier Opening Balance being
-- edited or reversed later.
--
-- Design note on the preview RPC: rather than re-implementing the cascade
-- arithmetic a second time (a real risk of preview/apply silently
-- disagreeing), the mutating logic is factored into an internal core
-- function that BOTH the real apply RPC and the preview RPC call --
-- preview wraps the call in a sub-transaction it deliberately rolls back
-- via a caught exception, so it is guaranteed to see exactly the numbers a
-- real apply would produce, never an approximation.

BEGIN;

-- ---------------------------------------------------------------------------
-- Internal: reconstructed balance strictly before a timeline position.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._balance_historical_position_before_v1(
  p_organization_id  uuid,
  p_user_id          uuid,
  p_effective_date   date,
  p_day_position     smallint,
  p_sequence_number  integer,
  p_exclude_anchor_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(delta), 0)::numeric(14,2)
  FROM (
    SELECT a.materialized_delta AS delta
    FROM public.balance_historical_anchors a
    WHERE a.organization_id = p_organization_id
      AND a.user_id = p_user_id
      AND a.status = 'active'
      AND (p_exclude_anchor_id IS NULL OR a.id <> p_exclude_anchor_id)
      AND ROW(a.effective_date, a.day_position, a.sequence_number)
          < ROW(p_effective_date, p_day_position, p_sequence_number)

    UNION ALL

    SELECT bl.amount_delta AS delta
    FROM public.balance_ledger bl
    WHERE bl.organization_id = p_organization_id
      AND bl.user_id = p_user_id
      AND bl.entry_type NOT IN (
        'historical_opening', 'historical_balance_update',
        'historical_anchor_recalculation', 'historical_anchor_reversal'
      )
      AND ROW(bl.effective_at::date, 1::smallint, floor(extract(epoch FROM bl.effective_at))::bigint)
          < ROW(p_effective_date, p_day_position, p_sequence_number::bigint)

    UNION ALL

    SELECT (-ebd.expense_amount) AS delta
    FROM public.expense_balance_deductions ebd
    WHERE ebd.organization_id = p_organization_id
      AND ebd.employee_user_id = p_user_id
      AND ROW(ebd.created_at::date, 1::smallint, floor(extract(epoch FROM ebd.created_at))::bigint)
          < ROW(p_effective_date, p_day_position, p_sequence_number::bigint)
  ) s;
$$;

REVOKE ALL ON FUNCTION public._balance_historical_position_before_v1(uuid, uuid, date, smallint, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_historical_position_before_v1(uuid, uuid, date, smallint, integer, uuid) FROM anon, authenticated;

COMMENT ON FUNCTION public._balance_historical_position_before_v1(uuid, uuid, date, smallint, integer, uuid) IS
  'Internal. Reconstructed balance strictly before a (date, day_position, '
  'sequence) timeline position, summing other active anchors'' current '
  'materialized_delta plus ordinary balance_ledger/expense_balance_deductions '
  'evidence. day_position 0=start of day (Opening Balance), 1=an ordinary '
  'event''s own calendar day, 2=end of day (Balance Update).';

-- ---------------------------------------------------------------------------
-- Internal: next same-day sequence number for a new anchor of this kind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._balance_next_anchor_sequence_v1(
  p_organization_id uuid,
  p_user_id         uuid,
  p_effective_date  date,
  p_anchor_kind     text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(MAX(a.sequence_number), 0) + 1
  FROM public.balance_historical_anchors a
  WHERE a.organization_id = p_organization_id
    AND a.user_id = p_user_id
    AND a.effective_date = p_effective_date
    AND a.anchor_kind = p_anchor_kind;
$$;

REVOKE ALL ON FUNCTION public._balance_next_anchor_sequence_v1(uuid, uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_next_anchor_sequence_v1(uuid, uuid, date, text) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal: materialize (or recalculate, or zero-out-on-reversal) ONE
-- anchor's own ledger effect and apply the NET CHANGE to profiles.balance.
-- Caller MUST already hold `SELECT ... FOR UPDATE` on the target profile row
-- before calling this.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._balance_materialize_anchor_v1(
  p_anchor_id      uuid,
  p_actor_user_id  uuid,
  p_mode           text -- 'initial' | 'recalculate' | 'reverse'
)
RETURNS numeric
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor          public.balance_historical_anchors%ROWTYPE;
  v_position_before numeric;
  v_new_delta       numeric;
  v_old_delta       numeric;
  v_net             numeric;
  v_entry_type      text;
  v_balance_before  numeric;
  v_balance_after   numeric;
  v_ledger_id       uuid;
  v_effective_at    timestamptz;
BEGIN
  IF p_mode NOT IN ('initial', 'recalculate', 'reverse') THEN
    RAISE EXCEPTION 'invalid materialization mode: %', p_mode;
  END IF;

  SELECT * INTO v_anchor FROM public.balance_historical_anchors WHERE id = p_anchor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historical anchor % not found', p_anchor_id;
  END IF;

  v_old_delta := COALESCE(v_anchor.materialized_delta, 0);

  IF p_mode = 'reverse' THEN
    v_new_delta := 0;
    v_entry_type := 'historical_anchor_reversal';
  ELSE
    v_position_before := public._balance_historical_position_before_v1(
      v_anchor.organization_id, v_anchor.user_id, v_anchor.effective_date,
      v_anchor.day_position, v_anchor.sequence_number, v_anchor.id
    );
    v_new_delta := v_anchor.stated_balance - v_position_before;
    v_entry_type := CASE
      WHEN p_mode = 'initial' THEN
        CASE WHEN v_anchor.anchor_kind = 'opening_balance' THEN 'historical_opening' ELSE 'historical_balance_update' END
      ELSE 'historical_anchor_recalculation'
    END;
  END IF;

  v_net := v_new_delta - v_old_delta;

  UPDATE public.balance_historical_anchors
  SET materialized_delta = v_new_delta
  WHERE id = p_anchor_id;

  IF v_net <> 0 THEN
    SELECT COALESCE(balance, 0) INTO v_balance_before
    FROM public.profiles WHERE user_id = v_anchor.user_id AND organization_id = v_anchor.organization_id;

    UPDATE public.profiles
    SET balance = balance + v_net, updated_at = now()
    WHERE user_id = v_anchor.user_id AND organization_id = v_anchor.organization_id
    RETURNING balance INTO v_balance_after;

    IF v_balance_after IS NULL THEN
      RAISE EXCEPTION 'historical anchor %: profile update affected no row', p_anchor_id;
    END IF;

    v_effective_at := v_anchor.effective_date
      + CASE v_anchor.day_position WHEN 0 THEN interval '0 seconds' ELSE interval '23:59:59.999999 seconds' END;

    INSERT INTO public.balance_ledger (
      organization_id, user_id, amount_delta, balance_before, balance_after,
      entry_type, source_type, source_id, actor_user_id, effective_at, note
    ) VALUES (
      v_anchor.organization_id, v_anchor.user_id, v_net, v_balance_before, v_balance_after,
      v_entry_type, 'historical_anchor', p_anchor_id, p_actor_user_id, v_effective_at, v_anchor.note
    ) RETURNING id INTO v_ledger_id;
  END IF;

  RETURN v_net;
END;
$$;

REVOKE ALL ON FUNCTION public._balance_materialize_anchor_v1(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_materialize_anchor_v1(uuid, uuid, text) FROM anon, authenticated;

COMMENT ON FUNCTION public._balance_materialize_anchor_v1(uuid, uuid, text) IS
  'Internal. Computes ONE anchor''s current materialized_delta and applies '
  'only the NET CHANGE (new minus old) to profiles.balance, via a new '
  'balance_ledger row -- never sets balance to the anchor''s stated_balance '
  'directly. Caller must already hold FOR UPDATE on the target profile.';

-- ---------------------------------------------------------------------------
-- Internal: recalculate every ACTIVE anchor strictly after a timeline
-- position, in ascending order, for one employee. Caller must already hold
-- FOR UPDATE on the target profile.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._balance_cascade_downstream_anchors_v1(
  p_organization_id  uuid,
  p_user_id          uuid,
  p_effective_date   date,
  p_day_position     smallint,
  p_sequence_number  integer,
  p_actor_user_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_anchor_id  uuid;
  v_old_delta  numeric;
  v_new_delta  numeric;
  v_net        numeric;
  v_results    jsonb := '[]'::jsonb;
BEGIN
  FOR v_anchor_id IN
    SELECT a.id
    FROM public.balance_historical_anchors a
    WHERE a.organization_id = p_organization_id
      AND a.user_id = p_user_id
      AND a.status = 'active'
      AND ROW(a.effective_date, a.day_position, a.sequence_number)
          > ROW(p_effective_date, p_day_position, p_sequence_number)
    ORDER BY a.effective_date, a.day_position, a.sequence_number
  LOOP
    SELECT COALESCE(materialized_delta, 0) INTO v_old_delta
    FROM public.balance_historical_anchors WHERE id = v_anchor_id;

    v_net := public._balance_materialize_anchor_v1(v_anchor_id, p_actor_user_id, 'recalculate');

    SELECT materialized_delta INTO v_new_delta
    FROM public.balance_historical_anchors WHERE id = v_anchor_id;

    IF v_net <> 0 THEN
      v_results := v_results || jsonb_build_object(
        'anchor_id', v_anchor_id, 'old_delta', v_old_delta, 'new_delta', v_new_delta, 'net_change', v_net
      );
    END IF;
  END LOOP;
  RETURN v_results;
END;
$$;

REVOKE ALL ON FUNCTION public._balance_cascade_downstream_anchors_v1(uuid, uuid, date, smallint, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_cascade_downstream_anchors_v1(uuid, uuid, date, smallint, integer, uuid) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal CORE: create-or-supersede one anchor + cascade. Contains ZERO
-- authorization logic and trusts p_actor_user_id completely -- it is
-- deliberately NOT reachable by any client role (revoked from PUBLIC, anon,
-- AND authenticated; only callable from within another function owned by
-- the same role, which Postgres permits implicitly regardless of GRANTs).
-- Both the real apply RPC and the preview RPC call this SAME function, so
-- preview can never silently disagree with what apply would actually do.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._balance_apply_historical_anchor_core_v1(
  p_organization_id  uuid,
  p_target_user_id   uuid,
  p_anchor_kind      text,
  p_effective_date   date,
  p_stated_balance   numeric,
  p_action           text,
  p_note             text,
  p_target_anchor_id uuid,
  p_reason           text,
  p_source_import_batch_id uuid,
  p_source_import_row_id   uuid,
  p_actor_user_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day_position   smallint;
  v_sequence       integer;
  v_old_anchor     public.balance_historical_anchors%ROWTYPE;
  v_revision_group uuid;
  v_revision_no    integer;
  v_new_id         uuid;
  v_net            numeric;
  v_downstream     jsonb;
  v_reason         text := nullif(trim(p_reason), '');
  v_current_before numeric;
  v_current_after  numeric;
BEGIN
  v_day_position := CASE p_anchor_kind WHEN 'opening_balance' THEN 0 ELSE 2 END;

  PERFORM 1 FROM public.profiles WHERE user_id = p_target_user_id AND organization_id = p_organization_id FOR UPDATE;

  SELECT COALESCE(balance, 0) INTO v_current_before
  FROM public.profiles WHERE user_id = p_target_user_id AND organization_id = p_organization_id;

  IF p_action = 'supersede' THEN
    IF p_target_anchor_id IS NULL THEN
      RAISE EXCEPTION 'supersede requires a target anchor';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'A reason is required to replace/edit a historical balance anchor';
    END IF;

    SELECT * INTO v_old_anchor
    FROM public.balance_historical_anchors
    WHERE id = p_target_anchor_id AND organization_id = p_organization_id AND user_id = p_target_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target anchor not found for this employee';
    END IF;
    IF v_old_anchor.status <> 'active' THEN
      RAISE EXCEPTION 'target anchor is not active (status=%) -- it may already have been superseded or reversed', v_old_anchor.status;
    END IF;

    v_revision_group := v_old_anchor.revision_group_id;
    v_revision_no := v_old_anchor.revision_number + 1;
    IF p_effective_date = v_old_anchor.effective_date AND p_anchor_kind = v_old_anchor.anchor_kind THEN
      v_sequence := v_old_anchor.sequence_number;
    ELSE
      v_sequence := public._balance_next_anchor_sequence_v1(p_organization_id, p_target_user_id, p_effective_date, p_anchor_kind);
    END IF;

    UPDATE public.balance_historical_anchors
    SET status = 'superseded', superseded_at = now()
    WHERE id = v_old_anchor.id;
  ELSIF p_action = 'create' THEN
    v_revision_group := gen_random_uuid();
    v_revision_no := 1;
    v_sequence := public._balance_next_anchor_sequence_v1(p_organization_id, p_target_user_id, p_effective_date, p_anchor_kind);
  ELSE
    RAISE EXCEPTION 'invalid action: %', p_action;
  END IF;

  -- IMPORTANT: when superseding, the new revision's materialized_delta
  -- starts from the OLD revision's current materialized_delta (its
  -- ALREADY-APPLIED effect on profiles.balance), not from zero/NULL. The
  -- old row is marked 'superseded' -- excluded from every future
  -- position-before calculation -- but its historical ledger effect is
  -- still sitting in profiles.balance and has not been reversed by
  -- anything else. Materializing the new row as if its "old delta" were 0
  -- would ADD the new delta on top of the still-present old one instead of
  -- REPLACING it. Seeding materialized_delta here is what makes
  -- _balance_materialize_anchor_v1's mode='initial' net-change calculation
  -- (new_delta - old_delta) correctly represent "replace the old
  -- contribution with the new one".
  INSERT INTO public.balance_historical_anchors (
    organization_id, user_id, anchor_kind, effective_date, day_position, sequence_number,
    stated_balance, materialized_delta, status, revision_group_id, revision_number, supersedes_anchor_id,
    source_import_batch_id, source_import_row_id, note, reason, created_by
  ) VALUES (
    p_organization_id, p_target_user_id, p_anchor_kind, p_effective_date, v_day_position, v_sequence,
    p_stated_balance,
    CASE WHEN p_action = 'supersede' THEN v_old_anchor.materialized_delta ELSE NULL END,
    'active', v_revision_group, v_revision_no,
    CASE WHEN p_action = 'supersede' THEN v_old_anchor.id ELSE NULL END,
    p_source_import_batch_id, p_source_import_row_id, p_note, v_reason, p_actor_user_id
  ) RETURNING id INTO v_new_id;

  IF p_action = 'supersede' THEN
    UPDATE public.balance_historical_anchors SET superseded_by = v_new_id WHERE id = v_old_anchor.id;
  END IF;

  v_net := public._balance_materialize_anchor_v1(v_new_id, p_actor_user_id, 'initial');

  v_downstream := public._balance_cascade_downstream_anchors_v1(
    p_organization_id, p_target_user_id, p_effective_date, v_day_position, v_sequence, p_actor_user_id
  );

  SELECT COALESCE(balance, 0) INTO v_current_after
  FROM public.profiles WHERE user_id = p_target_user_id AND organization_id = p_organization_id;

  RETURN jsonb_build_object(
    'ok', true,
    'anchor_id', v_new_id,
    'revision_group_id', v_revision_group,
    'revision_number', v_revision_no,
    'materialized_delta', v_net,
    'current_balance_before', v_current_before,
    'current_balance_after', v_current_after,
    'downstream_anchors_recalculated', v_downstream
  );
END;
$$;

REVOKE ALL ON FUNCTION public._balance_apply_historical_anchor_core_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._balance_apply_historical_anchor_core_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid, uuid) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public: atomically create or supersede one historical balance anchor for
-- one employee, cascading downstream recalculation. Admin-only,
-- organization-scoped, server-authoritative throughout. Thin wrapper:
-- validates + authorizes, then delegates to the core function above with
-- auth.uid() as the trusted actor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.balance_apply_historical_anchor_v1(
  p_organization_id  uuid,
  p_target_user_id   uuid,
  p_anchor_kind      text,
  p_effective_date   date,
  p_stated_balance   numeric,
  p_action           text,               -- 'create' | 'supersede'
  p_note             text DEFAULT NULL,
  p_target_anchor_id uuid DEFAULT NULL,
  p_reason           text DEFAULT NULL,  -- required when p_action = 'supersede'
  p_source_import_batch_id uuid DEFAULT NULL,
  p_source_import_row_id   uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_caller_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_organization_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'organization and target employee are required';
  END IF;
  IF p_anchor_kind NOT IN ('opening_balance', 'balance_update') THEN
    RAISE EXCEPTION 'invalid anchor kind: %', p_anchor_kind;
  END IF;
  IF p_action NOT IN ('create', 'supersede') THEN
    RAISE EXCEPTION 'invalid action: %', p_action;
  END IF;
  IF p_stated_balance IS NULL OR p_stated_balance <> p_stated_balance
     OR p_stated_balance = 'infinity'::numeric OR p_stated_balance = '-infinity'::numeric THEN
    RAISE EXCEPTION 'stated balance is missing or not a valid number';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may record a historical balance anchor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.organization_memberships om
      ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
    WHERE p.user_id = p_target_user_id AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'target employee not found in this organization';
  END IF;

  RETURN public._balance_apply_historical_anchor_core_v1(
    p_organization_id, p_target_user_id, p_anchor_kind, p_effective_date, p_stated_balance,
    p_action, p_note, p_target_anchor_id, p_reason, p_source_import_batch_id, p_source_import_row_id, v_uid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_apply_historical_anchor_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_apply_historical_anchor_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_apply_historical_anchor_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.balance_apply_historical_anchor_v1(uuid, uuid, text, date, numeric, text, text, uuid, text, uuid, uuid) IS
  'Atomic. Creates a brand-new historical anchor, or supersedes an existing '
  'active one with a new revision (never edits financial fields in place), '
  'materializes only the NET CHANGE to profiles.balance, and cascades '
  'recalculation to every downstream active anchor for the same employee. '
  'Admin-only. One employee per call -- balance_apply_import_v2 (companion '
  'migration) loops the internal core function per row for bulk import.';

-- ---------------------------------------------------------------------------
-- Public, read-only (as observed by the caller): preview the effect of
-- creating or superseding an anchor. Internally performs the REAL mutation
-- inside a sub-transaction via the core function above, then deliberately
-- raises a sentinel exception to roll it back before returning -- this is
-- what guarantees the preview can never drift from what apply would do,
-- without duplicating the cascade arithmetic. Conflicts are detected first
-- and returned without ever calling the core function if creating would
-- violate the one-active-Opening-Balance rule (the core function does not
-- special-case that -- the unique index would raise a raw constraint error).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.balance_preview_historical_anchor_v1(
  p_organization_id uuid,
  p_target_user_id  uuid,
  p_anchor_kind     text,
  p_effective_date  date,
  p_stated_balance  numeric,
  p_action          text,           -- 'create' | 'supersede'
  p_target_anchor_id uuid DEFAULT NULL,
  p_note            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_caller_role      text;
  v_conflicts        jsonb := '[]'::jsonb;
  v_existing_opening record;
  v_existing_same_day jsonb;
  v_core_result      jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_anchor_kind NOT IN ('opening_balance', 'balance_update') THEN
    RAISE EXCEPTION 'invalid anchor kind: %', p_anchor_kind;
  END IF;
  IF p_action NOT IN ('create', 'supersede') THEN
    RAISE EXCEPTION 'invalid action: %', p_action;
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may preview a historical balance anchor';
  END IF;

  IF p_action = 'create' THEN
    IF p_anchor_kind = 'opening_balance' THEN
      SELECT id, effective_date, stated_balance, note, created_by, created_at
        INTO v_existing_opening
      FROM public.balance_historical_anchors
      WHERE organization_id = p_organization_id AND user_id = p_target_user_id
        AND anchor_kind = 'opening_balance' AND status = 'active';
      IF FOUND THEN
        v_conflicts := v_conflicts || jsonb_build_object(
          'conflict_type', 'opening_balance_exists',
          'existing_anchor_id', v_existing_opening.id,
          'existing_effective_date', v_existing_opening.effective_date,
          'existing_stated_balance', v_existing_opening.stated_balance,
          'existing_note', v_existing_opening.note,
          'existing_created_by', v_existing_opening.created_by,
          'existing_created_at', v_existing_opening.created_at
        );
        -- Creating would violate balance_historical_anchors_one_active_opening_uidx.
        -- Return the conflict without attempting the core function at all.
        RETURN jsonb_build_object('ok', true, 'conflicts', v_conflicts, 'preview_only', true, 'blocked', true);
      END IF;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'existing_anchor_id', a.id, 'stated_balance', a.stated_balance, 'note', a.note,
      'created_by', a.created_by, 'created_at', a.created_at, 'sequence_number', a.sequence_number
    )), '[]'::jsonb) INTO v_existing_same_day
    FROM public.balance_historical_anchors a
    WHERE a.organization_id = p_organization_id AND a.user_id = p_target_user_id
      AND a.anchor_kind = p_anchor_kind AND a.effective_date = p_effective_date AND a.status = 'active';

    IF jsonb_array_length(v_existing_same_day) > 0 THEN
      v_conflicts := v_conflicts || jsonb_build_object(
        'conflict_type', 'same_day_anchor_exists', 'existing_anchors', v_existing_same_day
      );
    END IF;
  END IF;

  BEGIN
    v_core_result := public._balance_apply_historical_anchor_core_v1(
      p_organization_id, p_target_user_id, p_anchor_kind, p_effective_date, p_stated_balance,
      p_action, p_note, p_target_anchor_id, '[preview -- rolled back, not a real reason]',
      NULL, NULL, v_uid
    );
    RAISE EXCEPTION 'PESOWISE_PREVIEW_ROLLBACK_SENTINEL';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'PESOWISE_PREVIEW_ROLLBACK_SENTINEL' THEN
        RETURN v_core_result || jsonb_build_object('conflicts', v_conflicts, 'preview_only', true, 'blocked', false);
      END IF;
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.balance_preview_historical_anchor_v1(uuid, uuid, text, date, numeric, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_preview_historical_anchor_v1(uuid, uuid, text, date, numeric, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_preview_historical_anchor_v1(uuid, uuid, text, date, numeric, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.balance_preview_historical_anchor_v1(uuid, uuid, text, date, numeric, text, uuid, text) IS
  'Read-only as observed by the caller. Runs the REAL apply logic inside a '
  'sub-transaction via _balance_apply_historical_anchor_core_v1, then '
  'deliberately rolls it back via a caught sentinel exception -- guarantees '
  'the previewed numbers are exactly what a real apply would produce, '
  'rather than a separately-maintained approximation that could drift. The '
  'reason string passed to the core function during a supersede preview is '
  'a placeholder and is discarded by the rollback; the real apply call '
  'requires and stores the admin''s actual reason.';

-- ---------------------------------------------------------------------------
-- Public: reverse (retire without a replacement) an active historical
-- anchor, cascading downstream recalculation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.balance_reverse_historical_anchor_v1(
  p_anchor_id uuid,
  p_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_anchor      public.balance_historical_anchors%ROWTYPE;
  v_caller_role text;
  v_reason      text := nullif(trim(p_reason), '');
  v_net         numeric;
  v_downstream  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reverse a historical balance anchor';
  END IF;

  SELECT * INTO v_anchor FROM public.balance_historical_anchors WHERE id = p_anchor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historical anchor not found';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_anchor.organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may reverse a historical balance anchor';
  END IF;

  IF v_anchor.status <> 'active' THEN
    RAISE EXCEPTION 'anchor is not active (status=%) -- only an active anchor can be reversed', v_anchor.status;
  END IF;

  PERFORM 1 FROM public.profiles WHERE user_id = v_anchor.user_id AND organization_id = v_anchor.organization_id FOR UPDATE;

  UPDATE public.balance_historical_anchors
  SET status = 'reversed', reversed_at = now(), reversed_by = v_uid, reversal_reason = v_reason
  WHERE id = p_anchor_id;

  v_net := public._balance_materialize_anchor_v1(p_anchor_id, v_uid, 'reverse');

  v_downstream := public._balance_cascade_downstream_anchors_v1(
    v_anchor.organization_id, v_anchor.user_id, v_anchor.effective_date, v_anchor.day_position, v_anchor.sequence_number, v_uid
  );

  RETURN jsonb_build_object(
    'ok', true,
    'anchor_id', p_anchor_id,
    'reversal_net_change', v_net,
    'downstream_anchors_recalculated', v_downstream
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_reverse_historical_anchor_v1(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_reverse_historical_anchor_v1(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_reverse_historical_anchor_v1(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.balance_reverse_historical_anchor_v1(uuid, text) IS
  'Atomic. Retires an active historical anchor (status=reversed, never '
  'deleted), zeroes its own ledger effect via a compensating '
  'historical_anchor_reversal row, and cascades recalculation to every '
  'downstream active anchor for the same employee -- the net effect on '
  'todays balance is NOT simply "-stated_balance"; it depends on whatever '
  'later anchors re-establish. Admin-only.';

-- ---------------------------------------------------------------------------
-- Public, read-only: an employee's historical anchors, in timeline order.
-- Admin-only (organization-scoped). p_include_superseded surfaces the full
-- revision chain for the "Show corrections / revisions" UI.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_balance_historical_anchors_v1(
  p_organization_id    uuid,
  p_user_id            uuid,
  p_include_superseded boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_caller_role text;
  v_rows        jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = p_organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may view historical balance anchors';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.effective_date, x.day_position, x.sequence_number, x.revision_number), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT a.id, a.anchor_kind, a.effective_date, a.day_position, a.sequence_number,
           a.stated_balance, a.materialized_delta, a.status,
           a.revision_group_id, a.revision_number, a.supersedes_anchor_id, a.superseded_by, a.superseded_at,
           a.reversed_at, a.reversed_by, a.reversal_reason,
           a.note, a.reason, a.created_by, a.created_at,
           creator.name AS created_by_name
    FROM public.balance_historical_anchors a
    LEFT JOIN public.profiles creator
           ON creator.user_id = a.created_by AND creator.organization_id = a.organization_id
    WHERE a.organization_id = p_organization_id
      AND a.user_id = p_user_id
      AND (p_include_superseded OR a.status = 'active')
  ) x;

  RETURN jsonb_build_object('ok', true, 'anchors', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.get_balance_historical_anchors_v1(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_balance_historical_anchors_v1(uuid, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_balance_historical_anchors_v1(uuid, uuid, boolean) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
