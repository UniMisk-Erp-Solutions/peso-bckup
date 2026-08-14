-- Resolve expense submitter display info when expenses.user_id is stale (profile deleted/re-imported).
-- Maps orphan auth email emp.{org}.{employee_id}.{suffix}@... to current org profile by employee_id.

CREATE OR REPLACE FUNCTION public.get_expense_submitter_profiles(
  p_organization_id uuid,
  p_user_ids uuid[]
)
RETURNS TABLE(
  user_id uuid,
  name text,
  email text,
  balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    uid AS user_id,
    COALESCE(
      p.name,
      mapped.name,
      nullif(trim(au.raw_user_meta_data->>'name'), ''),
      nullif(trim(au.raw_user_meta_data->>'full_name'), ''),
      initcap(replace(split_part(au.email, '@', 1), '.', ' '))
    ) AS name,
    COALESCE(p.email, mapped.email, au.email, '') AS email,
    COALESCE(p.balance, mapped.balance, 0::numeric) AS balance
  FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS uid
  LEFT JOIN public.profiles p
    ON p.user_id = uid
   AND p.organization_id = p_organization_id
  LEFT JOIN auth.users au ON au.id = uid
  LEFT JOIN LATERAL (
    SELECT p2.name, p2.email, p2.balance
    FROM public.profiles p2
    WHERE p2.organization_id = p_organization_id
      AND p2.employee_id IS NOT NULL
      AND trim(p2.employee_id) <> ''
      AND lower(trim(p2.employee_id)) = lower(
        substring(au.email from 'emp\.[^.]+\.([^.]+)\.')
      )
    LIMIT 1
  ) mapped ON p.user_id IS NULL
$$;

REVOKE ALL ON FUNCTION public.get_expense_submitter_profiles(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_submitter_profiles(uuid, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_expense_submitter_profiles(uuid, uuid[]) IS
  'Expense list helper: direct org profile, else match current employee by synthetic auth email, else auth metadata.';
