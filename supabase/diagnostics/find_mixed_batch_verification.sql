-- DOC-098 — Reusable, read-only diagnostic for probable Bulk-Verify batch
-- splits (support tool). SELECT ONLY. No mutation. Safe to run repeatedly
-- against Production.
--
-- A "mixed" batch is one where at least one child has advanced past
-- team_leader/executive hierarchy verification (level_2_verified or later)
-- while at least one OTHER non-draft, non-terminal child of the SAME batch
-- has not. `draft` children are excluded from the "lagging" definition —
-- they were never submitted and are not evidence of a split Verify.
--
-- Usage: run section 1 first (candidates across ALL organizations, not just
-- one). Section 2 narrows to genuinely lagging (non-draft) children with
-- full identity/audit detail for the recovery table. Section 3 is a
-- best-effort HISTORICAL self-resolved signal (batches where a later manual
-- action completed what an earlier one missed) — an upper bound, not a
-- confirmed count; only individual audit-trail inspection confirms a given
-- batch.

\pset pager off
\x auto

\echo '=== SECTION 1: candidate mixed batches, ALL organizations ==='
WITH batch_children AS (
  SELECT e.*, o.name AS org_name
  FROM public.expenses e
  JOIN public.organizations o ON o.id = e.organization_id
  WHERE e.batch_id IS NOT NULL
),
batch_agg AS (
  SELECT
    bc.organization_id, bc.org_name, bc.batch_id, bc.user_id AS employee_user_id,
    count(*) AS total_children,
    count(*) FILTER (WHERE bc.status = 'level_2_verified') AS l2_count,
    count(*) FILTER (WHERE bc.status = 'approved') AS approved_count,
    -- 'paid' is FURTHER ALONG than 'approved' in this pipeline (draft ->
    -- submitted/edited -> level_1_verified -> level_2_verified -> approved ->
    -- paid). A batch where some children already reached 'paid' while
    -- siblings are still stuck earlier is a split too -- omitting this let a
    -- batch whose advanced children had already moved past 'approved' go
    -- undetected (DOC-098 same-day audit finding; made no difference to the
    -- single currently-open split as of 2026-08-19, but closes a real gap).
    count(*) FILTER (WHERE bc.status = 'paid') AS paid_count,
    count(*) FILTER (WHERE bc.status NOT IN ('level_2_verified','approved','rejected','paid','draft')) AS lagging_nondraft_count,
    count(*) FILTER (WHERE bc.status = 'draft') AS draft_count,
    max(bc.updated_at) AS batch_latest_update
  FROM batch_children bc
  GROUP BY bc.organization_id, bc.org_name, bc.batch_id, bc.user_id
)
SELECT ba.*, p.name AS employee_name, p.employee_id,
  CASE
    WHEN ba.lagging_nondraft_count = 0 THEN 'ALREADY_SELF_RESOLVED_OR_DRAFT_ONLY'
    WHEN ba.lagging_nondraft_count > 0 AND (ba.l2_count > 0 OR ba.approved_count > 0 OR ba.paid_count > 0) THEN 'PROBABLE_BULK_VERIFY_SPLIT'
    ELSE 'NEEDS_MANUAL_REVIEW'
  END AS classification
FROM batch_agg ba
LEFT JOIN public.profiles p ON p.user_id = ba.employee_user_id
WHERE (ba.l2_count > 0 OR ba.approved_count > 0 OR ba.paid_count > 0)
  AND (ba.lagging_nondraft_count > 0 OR ba.draft_count > 0)
ORDER BY ba.org_name, ba.batch_latest_update DESC;

\echo '=== SECTION 2: every currently lagging (non-draft) child, full recovery-table detail ==='
WITH batch_children AS (
  SELECT e.*, o.name AS org_name
  FROM public.expenses e
  JOIN public.organizations o ON o.id = e.organization_id
  WHERE e.batch_id IS NOT NULL
),
mixed_batches AS (
  SELECT batch_id
  FROM batch_children
  GROUP BY batch_id
  HAVING count(*) FILTER (WHERE status IN ('level_2_verified','approved','paid')) > 0
     AND count(*) FILTER (WHERE status NOT IN ('level_2_verified','approved','rejected','paid','draft')) > 0
)
SELECT
  bc.org_name AS organization,
  bc.organization_id,
  bc.batch_id,
  bc.transaction_number,
  bc.id AS expense_id,
  p.employee_id,
  p.name AS employee_name,
  bc.status,
  bc.approval_tier,
  bc.total_amount,
  bc.created_at,
  bc.updated_at,
  now() - bc.updated_at AS age,
  (SELECT max(al.created_at) FROM public.audit_logs al WHERE al.expense_id = bc.id AND al.action = 'tier_advanced') AS last_tier_advanced_at,
  'Complete via normal Verify (never Manager Override) once the assigned reviewer/current supervisor is available' AS recommended_action
FROM batch_children bc
JOIN mixed_batches mb ON mb.batch_id = bc.batch_id
LEFT JOIN public.profiles p ON p.user_id = bc.user_id AND p.organization_id = bc.organization_id
WHERE bc.status NOT IN ('level_2_verified','approved','rejected','paid','draft')
ORDER BY bc.org_name, bc.batch_id, bc.transaction_number;

\echo '=== SECTION 3: HISTORICAL self-resolved signal (UPPER BOUND, not a confirmed count) ==='
\echo '    A later tier_advanced cluster (>5min gap) on the same batch MAY mean an earlier'
\echo '    Bulk Verify missed some children and a later action (manual or bulk) completed'
\echo '    them -- OR it may be legitimate two-stage team_leader-then-executive progression.'
\echo '    Only individual audit-trail inspection (see Section 2 style detail per batch_id)'
\echo '    confirms which. Do not report this count as confirmed incidents without that check.'
WITH tier_events AS (
  SELECT e.batch_id, e.organization_id, o.name AS org_name, al.expense_id, al.created_at, al.user_id AS actor
  FROM public.audit_logs al
  JOIN public.expenses e ON e.id = al.expense_id
  JOIN public.organizations o ON o.id = e.organization_id
  WHERE al.action = 'tier_advanced'
    AND al.created_at > now() - interval '30 days'
    AND e.batch_id IS NOT NULL
),
batch_event_gaps AS (
  SELECT batch_id, org_name, created_at,
         created_at - lag(created_at) OVER (PARTITION BY batch_id ORDER BY created_at) AS gap_to_prev
  FROM tier_events
)
SELECT org_name, batch_id, count(*) AS total_tier_advance_events,
       count(*) FILTER (WHERE gap_to_prev > interval '5 minutes') AS distinct_clusters_after_first,
       min(created_at) AS first_event, max(created_at) AS last_event
FROM batch_event_gaps
GROUP BY org_name, batch_id
HAVING count(*) FILTER (WHERE gap_to_prev > interval '5 minutes') > 0
ORDER BY last_event DESC;
