-- DOC-044: Reviewer correction — custom field write authorization
--
-- Creates replace_expense_form_field_values_by_reviewer, which allows
-- assigned engineers, assigned reviewers, managers, executives, and
-- team leaders to atomically replace custom field values when applying
-- an expense correction.
--
-- The existing replace_expense_form_field_values RPC only authorizes the
-- expense owner (draft/submitted/rejected) or org admin.  That check fails
-- for hierarchy reviewers correcting an expense (who are not the owner and
-- may not be admins).  This new RPC widens the authorization correctly.
--
-- DO NOT APPLY via migrations run — run manually in the Supabase SQL editor
-- for project avrbgpmzabktqwyzqibq after verifying on a staging environment.

CREATE OR REPLACE FUNCTION public.replace_expense_form_field_values_by_reviewer(
  p_expense_id      UUID,
  p_organization_id UUID,
  p_values          JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID    := auth.uid();
  v_authorized BOOLEAN := FALSE;
BEGIN
  -- Org admin
  v_authorized := EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id         = v_uid
      AND om.organization_id = p_organization_id
      AND om.role            = 'admin'
      AND om.is_active       = true
  );

  -- Assigned engineer or reviewer on this specific expense
  IF NOT v_authorized THEN
    v_authorized := EXISTS (
      SELECT 1
      FROM public.expenses e
      WHERE e.id              = p_expense_id
        AND e.organization_id = p_organization_id
        AND (e.assigned_engineer_id = v_uid OR e.assigned_reviewer_id = v_uid)
    );
  END IF;

  -- Org-level hierarchy role (manager / executive / team_leader)
  IF NOT v_authorized THEN
    v_authorized := EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id         = v_uid
        AND om.organization_id = p_organization_id
        AND om.role            IN ('manager', 'executive', 'team_leader')
        AND om.is_active       = true
    );
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized to correct custom fields for this expense';
  END IF;

  -- Atomic replace: delete the full existing set, then insert the new set.
  -- Empty and null values are excluded (same semantics as replace_expense_form_field_values).
  DELETE FROM public.expense_form_field_values
  WHERE expense_id      = p_expense_id
    AND organization_id = p_organization_id;

  INSERT INTO public.expense_form_field_values
    (expense_id, organization_id, template_id, branch_field_id, field_value)
  SELECT
    p_expense_id,
    p_organization_id,
    NULLIF(trim(r->>'template_id'), '')::UUID,
    NULLIF(trim(r->>'branch_field_id'), '')::UUID,
    r->>'field_value'
  FROM jsonb_array_elements(p_values) AS r
  WHERE r->>'field_value' IS NOT NULL
    AND trim(r->>'field_value') <> '';
END;
$$;

GRANT EXECUTE
  ON FUNCTION public.replace_expense_form_field_values_by_reviewer(UUID, UUID, JSONB)
  TO authenticated;
