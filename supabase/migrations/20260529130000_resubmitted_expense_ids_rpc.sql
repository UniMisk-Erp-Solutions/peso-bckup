-- POST-based batch lookups avoid giant GET URLs (Coolify/nginx CORS preflight failures).

CREATE OR REPLACE FUNCTION public.get_resubmitted_expense_ids(p_expense_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT al.expense_id
  FROM public.audit_logs al
  WHERE al.action = 'expense_resubmitted'
    AND al.expense_id = ANY(p_expense_ids);
$$;

CREATE OR REPLACE FUNCTION public.get_reviewer_corrected_expense_ids(
  p_expense_ids uuid[],
  p_organization_id uuid DEFAULT NULL
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT ecl.expense_id
  FROM public.expense_correction_logs ecl
  WHERE ecl.expense_id = ANY(p_expense_ids)
    AND (
      p_organization_id IS NULL
      OR ecl.organization_id = p_organization_id
    );
$$;

REVOKE ALL ON FUNCTION public.get_resubmitted_expense_ids(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_resubmitted_expense_ids(uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.get_reviewer_corrected_expense_ids(uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reviewer_corrected_expense_ids(uuid[], uuid) TO authenticated;
