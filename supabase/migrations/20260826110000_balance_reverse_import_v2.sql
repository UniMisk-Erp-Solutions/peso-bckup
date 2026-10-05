-- Historical Balance Anchor V2 -- atomic, mode-aware import reversal.
--
-- balance_reverse_import_v1 only ever understood the allocation/historical_
-- opening SET/ADD model that predates the anchor system -- it reverses via a
-- single compensating balance_ledger entry per affected employee, which is
-- correct for allocation (a real additive transaction) but structurally
-- wrong for a batch that created HISTORICAL ANCHORS (whose net effect on
-- today's balance depends on cascading recalculation, never a flat "-delta").
--
-- balance_reverse_import_v2 is mode-aware:
--   allocation           -> delegates to balance_reverse_import_v1 UNCHANGED
--                           (byte-identical accounting; no need to duplicate it).
--   historical_opening /
--   balance_update       -> reverses each row's resulting_anchor_id through
--                           the CANONICAL single-anchor engine,
--                           balance_reverse_historical_anchor_v1 -- never
--                           duplicating its arithmetic. All-or-nothing: every
--                           anchor is verified (exists, belongs to this batch,
--                           still status='active') BEFORE any of them is
--                           touched. An anchor that was later edited/replaced
--                           (status='superseded') or already reversed
--                           (status='reversed') blocks the WHOLE batch
--                           reversal -- reversing a batch must never silently
--                           unwind a later, intentional manual correction.
--
-- A batch with status='applied' but zero resulting_anchor_id evidence is a
-- data-integrity problem, not "nothing to reverse" -- it RAISEs and the
-- batch stays 'applied' rather than being marked 'reversed' with nothing
-- actually undone (the exact false-reversed failure mode this function
-- exists to prevent).

CREATE OR REPLACE FUNCTION public.balance_reverse_import_v2(
  p_batch_id uuid,
  p_reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_batch          public.balance_import_batches%ROWTYPE;
  v_caller_role    text;
  v_reason         text := nullif(trim(p_reason), '');
  v_row            record;
  v_anchor         public.balance_historical_anchors%ROWTYPE;
  v_blocked        jsonb := '[]'::jsonb;
  v_blocked_text   text := '';
  v_anchor_ids     uuid[] := ARRAY[]::uuid[];
  v_sorted_ids     uuid[];
  v_anchor_id      uuid;
  v_single_result  jsonb;
  v_reversed_count integer := 0;
  v_net_total      numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reverse an import';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may reverse a balance import';
  END IF;

  IF v_batch.status <> 'applied' THEN
    RAISE EXCEPTION 'Only an applied import can be reversed (current status: %). '
      'If this batch was already reversed, reversing it again is not possible.', v_batch.status;
  END IF;

  -- Allocation is a real additive transaction with no anchor involved --
  -- the existing v1 engine's compensating-ledger-entry accounting is
  -- unchanged in v2, so this delegates rather than duplicating it.
  IF v_batch.mode = 'allocation' THEN
    RETURN public.balance_reverse_import_v1(p_batch_id, p_reason);
  END IF;

  -- historical_opening / balance_update: verify EVERY affected anchor with
  -- ZERO mutation before touching any of them.
  FOR v_row IN
    SELECT id, resulting_anchor_id
    FROM public.balance_import_rows
    WHERE batch_id = p_batch_id
      AND resulting_anchor_id IS NOT NULL
  LOOP
    SELECT * INTO v_anchor FROM public.balance_historical_anchors WHERE id = v_row.resulting_anchor_id;

    IF NOT FOUND THEN
      v_blocked := v_blocked || jsonb_build_object(
        'row_id', v_row.id, 'anchor_id', v_row.resulting_anchor_id,
        'reason', 'Referenced historical anchor no longer exists.'
      );
      v_blocked_text := v_blocked_text || format(E'\n- row %s: anchor missing', v_row.id);
      CONTINUE;
    END IF;

    IF v_anchor.organization_id <> v_batch.organization_id
       OR v_anchor.source_import_batch_id IS DISTINCT FROM p_batch_id THEN
      v_blocked := v_blocked || jsonb_build_object(
        'row_id', v_row.id, 'anchor_id', v_anchor.id,
        'reason', 'Anchor provenance does not match this batch.'
      );
      v_blocked_text := v_blocked_text || format(E'\n- row %s: provenance mismatch', v_row.id);
      CONTINUE;
    END IF;

    IF v_anchor.status <> 'active' THEN
      v_blocked := v_blocked || jsonb_build_object(
        'row_id', v_row.id, 'anchor_id', v_anchor.id, 'anchor_status', v_anchor.status,
        'reason', format(
          'Anchor is %s, not active -- it was edited/replaced or already reversed since this import.',
          v_anchor.status
        )
      );
      v_blocked_text := v_blocked_text || format(E'\n- row %s: anchor status=%s', v_row.id, v_anchor.status);
      CONTINUE;
    END IF;

    v_anchor_ids := array_append(v_anchor_ids, v_anchor.id);
  END LOOP;

  IF jsonb_array_length(v_blocked) > 0 THEN
    RAISE EXCEPTION 'This import cannot be automatically reversed -- % anchor(s) are no longer in their '
      'original state (edited, replaced, or already reversed). Zero changes made.%',
      jsonb_array_length(v_blocked), v_blocked_text;
  END IF;

  IF array_length(v_anchor_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No historical anchors found for this import batch -- nothing to reverse. '
      'The batch is left as applied; this indicates a data-integrity problem and should be '
      'investigated before any manual correction, never silently marked reversed.';
  END IF;

  -- Deterministic order (ascending anchor id), deduplicated -- a row's
  -- resulting_anchor_id is 1:1 in practice, but this stays correct even if
  -- that ever changes.
  SELECT ARRAY(SELECT DISTINCT a FROM unnest(v_anchor_ids) AS a ORDER BY a) INTO v_sorted_ids;

  FOREACH v_anchor_id IN ARRAY v_sorted_ids LOOP
    v_single_result := public.balance_reverse_historical_anchor_v1(v_anchor_id, v_reason);
    v_reversed_count := v_reversed_count + 1;
    v_net_total := v_net_total + COALESCE((v_single_result ->> 'reversal_net_change')::numeric, 0);
  END LOOP;

  UPDATE public.balance_import_batches
  SET status = 'reversed', reversed_at = now(), reversed_by = v_uid
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'mode', v_batch.mode,
    'reversed_count', v_reversed_count,
    'net_change_total', v_net_total,
    'blocked', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_reverse_import_v2(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_reverse_import_v2(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_reverse_import_v2(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.balance_reverse_import_v2(uuid, text) IS
  'Mode-aware, all-or-nothing import reversal. Allocation delegates to '
  'balance_reverse_import_v1 unchanged. historical_opening/balance_update '
  'reverse each row''s resulting_anchor_id through the canonical '
  'balance_reverse_historical_anchor_v1 engine (never duplicated arithmetic), '
  'after verifying every anchor is still active and belongs to this batch -- '
  'a later manual edit/replace or an already-reversed anchor blocks the '
  'WHOLE batch reversal with zero mutation, never a partial one. A batch '
  'with zero anchor evidence RAISEs rather than being marked reversed with '
  'nothing actually undone. Admin-only.';

NOTIFY pgrst, 'reload schema';
