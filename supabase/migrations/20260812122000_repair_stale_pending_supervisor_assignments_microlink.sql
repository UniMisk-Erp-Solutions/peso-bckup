-- Debug branch debug/6456-supervisor-auth-runtime — one-time existing-data
-- repair, companion to 20260812120000 (server authority) and 20260812121000
-- (future-sync trigger). Those two migrations make verification correct
-- going forward (dynamic fallback) and prevent NEW staleness (trigger). This
-- migration corrects the 1,775 pending rows that were ALREADY stale before
-- either of those migrations existed.
--
-- Scope: MicroLink only (organization_id
-- '6709c1fe-e8c8-404d-bc68-d1edda923344'), the only organization proven
-- affected by a live read-only audit across ALL organizations on this
-- instance (see the branch's incident report). This is a deliberate,
-- evidence-scoped exception to "no hardcoded org" — a one-time data repair
-- is intentionally narrower than the generic mechanism in the companion
-- migrations, which apply to every organization.
--
-- Eligibility (identical predicate to 20260812121000's trigger, applied
-- once instead of on every future profile update): status IN ('submitted',
-- 'edited', 'under_review') AND (approval_tier IS NULL OR IN
-- ('team_leader','executive')) AND assigned_reviewer_id IS DISTINCT FROM
-- the employee's CURRENT profiles.reporting_engineer_id. Terminal statuses,
-- level_1_verified/level_2_verified, and engineer/admin-tier rows are never
-- touched — only assigned_reviewer_id/assigned_engineer_id/updated_at
-- change; status, approval_tier, created_at, approved_by, approved_at,
-- total_amount and all financial fields are untouched.
--
-- Idempotent: safe to re-run — the WHERE clause only ever matches rows that
-- are still stale, so a second run updates zero rows.
--
-- Deliberately does NOT write to audit_logs (unlike the trigger in
-- 20260812121000): 1,775 per-expense audit rows appearing at once on a data
-- correction (not a real business event happening to any one employee) is
-- exactly the notification/audit-clutter this repair should avoid. Instead
-- writes one row per repaired expense to a small, permanent, dedicated
-- ledger table that is NOT exposed through the application (no RLS grants
-- to authenticated/anon) — a durable, deterministic rollback source distinct
-- from "relying on memory".

CREATE TABLE IF NOT EXISTS public.supervisor_reassignment_repair_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_user_id uuid NOT NULL,
  old_assigned_reviewer_id uuid,
  old_assigned_engineer_id uuid,
  new_assigned_reviewer_id uuid NOT NULL,
  new_assigned_engineer_id uuid NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  repair_batch text NOT NULL
);

COMMENT ON TABLE public.supervisor_reassignment_repair_log IS
  'One-time rollback/audit ledger for the 2026-08-12 MicroLink stale pending-supervisor-assignment repair. Not exposed to the application — no RLS policies, no grants beyond the migration role.';

-- Deliberately no RLS policies / no grants to authenticated or anon: this is
-- an internal operational ledger, not application-facing data.
ALTER TABLE public.supervisor_reassignment_repair_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supervisor_reassignment_repair_log FROM PUBLIC, anon, authenticated;

WITH candidates AS (
  SELECT e.id AS expense_id, e.organization_id, e.user_id AS employee_user_id,
         e.assigned_reviewer_id AS old_reviewer, e.assigned_engineer_id AS old_engineer,
         p.reporting_engineer_id AS new_supervisor
  FROM public.expenses e
  JOIN public.profiles p
    ON p.user_id = e.user_id AND p.organization_id = e.organization_id
  WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND e.status IN ('submitted', 'edited', 'under_review')
    AND (e.approval_tier IS NULL OR e.approval_tier IN ('team_leader', 'executive'))
    AND p.reporting_engineer_id IS NOT NULL
    AND p.reporting_engineer_id IS DISTINCT FROM e.assigned_reviewer_id
),
logged AS (
  INSERT INTO public.supervisor_reassignment_repair_log (
    expense_id, organization_id, employee_user_id,
    old_assigned_reviewer_id, old_assigned_engineer_id,
    new_assigned_reviewer_id, new_assigned_engineer_id, repair_batch
  )
  SELECT expense_id, organization_id, employee_user_id,
         old_reviewer, old_engineer, new_supervisor, new_supervisor,
         'microlink_2026-08-12'
  FROM candidates
  RETURNING expense_id, new_assigned_reviewer_id
)
UPDATE public.expenses e
SET assigned_reviewer_id = logged.new_assigned_reviewer_id,
    assigned_engineer_id = logged.new_assigned_reviewer_id,
    updated_at = now()
FROM logged
WHERE e.id = logged.expense_id;
