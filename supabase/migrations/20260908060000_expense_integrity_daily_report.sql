-- ─────────────────────────────────────────────────────────────────────────────
-- PesoWise · daily expense integrity report
--
-- One cheap, read-only call that answers the question we now care about most:
--
--     "is ANY recently-created expense incomplete or in an impossible state?"
--
-- It reuses the canonical live validator rather than reimplementing its rules,
-- so it cannot drift from what the database actually enforces. Nothing is
-- mutated; the validator is STABLE and every raise is caught per row.
--
-- Service-role / admin only: it spans every tenant, so it must not be reachable
-- from an ordinary authenticated session. It returns identifiers and status
-- only — no employee names, emails or amounts.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.expense_integrity_report_v1(
  p_days               integer     DEFAULT 7,
  -- The instant at which the last prevention layer went live (DOC-122). Rows
  -- created before it can be legitimately incomplete for historical reasons and
  -- are NOT evidence of a regression — see DOC-121/DOC-122. Kept as a parameter
  -- rather than a buried constant so the boundary is visible and adjustable.
  p_prevention_live_at timestamptz DEFAULT timestamptz '2026-09-07 14:24:08+00'
)
RETURNS TABLE (
  expense_id              uuid,
  transaction_number      text,
  organization_id         uuid,
  organization_name       text,
  status                  text,
  created_at              timestamptz,
  is_protected            boolean,
  missing_required_fields text,
  missing_number_flag     boolean,
  invalid_transition_flag boolean,
  predates_full_prevention boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r        record;
  v_msg    text;
  v_detail text;
  v_since  timestamptz := now() - make_interval(days => GREATEST(COALESCE(p_days, 7), 1));
BEGIN
  FOR r IN
    SELECT e.id, e.transaction_number, e.organization_id, o.name AS org_name,
           e.status::text AS st, e.created_at,
           public._expense_status_is_protected_v1(e.status::text) AS protected
    FROM public.expenses e
    JOIN public.organizations o ON o.id = e.organization_id
    WHERE e.created_at >= v_since
    ORDER BY e.created_at
  LOOP
    v_msg := NULL;
    v_detail := NULL;

    -- Only protected rows carry mandatory-field obligations. A draft is
    -- legitimately incomplete and must never be reported as a failure.
    IF r.protected THEN
      BEGIN
        PERFORM public.validate_expense_submission_invariants_v1(r.id);
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
        v_msg := COALESCE(v_msg, 'validation failed')
                 || CASE WHEN COALESCE(v_detail, '') <> '' THEN ' — ' || v_detail ELSE '' END;
      END;
    END IF;

    expense_id              := r.id;
    transaction_number      := r.transaction_number;
    organization_id         := r.organization_id;
    organization_name       := r.org_name;
    status                  := r.st;
    created_at              := r.created_at;
    is_protected            := r.protected;
    missing_required_fields := v_msg;

    -- A protected expense with no number is the DOC-121 symptom.
    missing_number_flag := r.protected AND r.transaction_number IS NULL;

    -- A protected expense that recorded a creation but never a submission is
    -- the DOC-122 state-machine bypass signature.
    --
    -- The expense_created requirement matters: some legacy rows carry NO audit
    -- history at all (a bulk import wrote 200 such rows in one tenant on
    -- 2026-08-13) and others predate complete audit logging. Those are silent
    -- about their lifecycle rather than evidence of a bypass, and flagging them
    -- would bury the real signal. Every one of them is numbered, and none is
    -- post-prevention.
    invalid_transition_flag := r.protected
      AND EXISTS     (SELECT 1 FROM public.audit_logs a
                       WHERE a.expense_id = r.id AND a.action = 'expense_created')
      AND NOT EXISTS (SELECT 1 FROM public.audit_logs a
                       WHERE a.expense_id = r.id AND a.action = 'expense_submitted');

    -- Separates "known historical straggler" from "new regression".
    predates_full_prevention := r.created_at < p_prevention_live_at;

    -- Only surface rows that actually have something wrong.
    IF missing_required_fields IS NOT NULL
       OR missing_number_flag
       OR invalid_transition_flag THEN
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.expense_integrity_report_v1(integer, timestamptz) IS
  'Read-only health check. Returns ONLY the recently-created expenses that are '
  'incomplete or in an impossible state: mandatory fields missing (per the live '
  'canonical validator), a protected expense with no transaction number, or a '
  'protected expense with no recorded submission. predates_full_prevention '
  'separates known historical stragglers from genuine new regressions. '
  'Empty result, or rows only where predates_full_prevention is true = healthy.';

-- The single-argument signature from the first draft of this migration would
-- otherwise linger as a second, divergent entry point.
DROP FUNCTION IF EXISTS public.expense_integrity_report_v1(integer);

REVOKE ALL ON FUNCTION public.expense_integrity_report_v1(integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_integrity_report_v1(integer, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.expense_integrity_report_v1(integer, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expense_integrity_report_v1(integer, timestamptz) TO service_role;

-- ── install-time proof ──────────────────────────────────────────────────────
DO $verify$
DECLARE n_bad int; n_new int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT predates_full_prevention)
    INTO n_bad, n_new
  FROM public.expense_integrity_report_v1(3);
  RAISE NOTICE 'integrity report, last 3 days: % problem row(s), of which % are POST-prevention',
    n_bad, n_new;
  IF n_new > 0 THEN
    RAISE WARNING 'there are % post-prevention problem rows — investigate before trusting this deploy', n_new;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
     WHERE routine_schema='public' AND routine_name='expense_integrity_report_v1'
       AND grantee='service_role') THEN
    RAISE EXCEPTION 'service_role was not granted execute on the integrity report';
  END IF;
END
$verify$;

COMMIT;
