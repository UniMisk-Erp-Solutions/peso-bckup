-- DOC-099/DOC-080 — server-authoritative approval preview, found missing
-- during an independent repo scan. New additive, READ-ONLY RPC. Does NOT
-- touch review_verify_batch_atomic_v1, review_approve_expense_v2, Manager
-- Override, or review queue pagination -- all of that is accepted as-is.
--
-- Problem: EngineerReview.tsx's resolveApprovalTargets() correctly does a
-- fresh server fetch of the selected batch's children and fails closed on
-- any fetch error (src/pages/EngineerReview.tsx:3175-3236, unchanged). But
-- the READY-vs-WAITING classification that follows
-- (classifySelection -> isPendingForCurrentReviewer,
-- EngineerReview.tsx:2815-2836/3316-3325) is a frontend reimplementation of
-- the same rules the server already computes canonically in
-- _debug_review_actionability_v1 (used by the live review queue via
-- get_debug_review_queue_page_v1) -- it can disagree with the server.
--
-- Fix: reuse the EXACT SAME canonical helpers the live queue already uses
-- (_debug_review_assert_reviewer_v1, _debug_review_caller_context_v1,
-- _debug_review_handoff_ids_v1, _debug_review_actionability_v1) in one new
-- read-only RPC that evaluates a caller-supplied set of already-known
-- expense IDs (the ones resolveApprovalTargets already fetched), instead of
-- paging a queue. No review authorization logic is duplicated or
-- reimplemented -- every rule comes from the same functions the queue uses.

CREATE OR REPLACE FUNCTION public.review_preview_approval_targets_v1(
  p_organization_id uuid,
  p_expense_ids     uuid[]
)
RETURNS TABLE (
  expense_id         uuid,
  transaction_number text,
  batch_id           uuid,
  employee_user_id   uuid,
  employee_id        text,
  employee_name      text,
  amount             numeric,
  status             text,
  approval_tier      text,
  is_actionable      boolean,
  actionable_stage   text,
  actionable_reason  text,
  available_actions  jsonb,
  is_terminal        boolean,
  in_assigned_scope  boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ctx jsonb;
BEGIN
  IF p_expense_ids IS NULL OR array_length(p_expense_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'p_expense_ids must be a non-empty array';
  END IF;
  IF array_length(p_expense_ids, 1) > 1000 THEN
    RAISE EXCEPTION 'Too many expenses in one preview request (max 1000)';
  END IF;

  -- Same reviewer-role gate the live queue enforces.
  PERFORM public._debug_review_assert_reviewer_v1(p_organization_id);
  v_ctx := public._debug_review_caller_context_v1(p_organization_id);

  RETURN QUERY
  WITH handoff AS (
    SELECT h.expense_id FROM public._debug_review_handoff_ids_v1(p_organization_id) h
  ),
  scope AS (
    SELECT s.expense_id FROM public._debug_review_assigned_scope_v1(p_organization_id) s
  ),
  target AS (
    SELECT e.id, e.transaction_number, e.batch_id, e.user_id, e.total_amount,
           e.status::text AS status, e.approval_tier,
           e.assigned_reviewer_id, e.assigned_engineer_id,
           public._debug_review_actionability_v1(
             v_ctx->>'role', (v_ctx->>'caller_user_id')::uuid,
             e.status::text, e.approval_tier,
             e.assigned_reviewer_id, e.assigned_engineer_id,
             (v_ctx->>'hierarchy_enabled')::boolean,
             (v_ctx->>'team_leader_enabled')::boolean,
             (v_ctx->>'executive_enabled')::boolean,
             EXISTS (SELECT 1 FROM handoff h WHERE h.expense_id = e.id)
           ) AS act
    FROM public.expenses e
    WHERE e.id = ANY(p_expense_ids)
      AND e.organization_id = p_organization_id
  )
  SELECT
    t.id,
    t.transaction_number,
    t.batch_id,
    t.user_id,
    p.employee_id,
    p.name,
    t.total_amount,
    t.status,
    t.approval_tier,
    (t.act->>'is_actionable')::boolean,
    t.act->>'actionable_stage',
    t.act->>'actionable_reason',
    t.act->'available_actions',
    t.status IN ('verified', 'approved', 'rejected'),
    EXISTS (SELECT 1 FROM scope sc WHERE sc.expense_id = t.id)
  FROM target t
  LEFT JOIN public.profiles p ON p.user_id = t.user_id AND p.organization_id = p_organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.review_preview_approval_targets_v1(uuid, uuid[]) IS
  'DOC-099/DOC-080. Read-only, server-authoritative approval preview for a '
  'caller-supplied set of already-resolved expense IDs (e.g. from '
  'resolveApprovalTargets''s fresh batch-children fetch). Reuses the exact '
  'same canonical helpers the live review queue uses '
  '(_debug_review_assert_reviewer_v1, _debug_review_caller_context_v1, '
  '_debug_review_handoff_ids_v1, _debug_review_actionability_v1) -- no '
  'review authorization rule is reimplemented here. Intended to replace the '
  'frontend isPendingForCurrentReviewer heuristic feeding classifySelection '
  'in EngineerReview.tsx''s approval dialog. Does not mutate anything.';

NOTIFY pgrst, 'reload schema';
