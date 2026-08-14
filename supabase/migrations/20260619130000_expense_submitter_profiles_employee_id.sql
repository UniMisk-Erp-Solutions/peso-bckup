-- Add employee_id to expense submitter lookup (search/filter by employee ID in admin lists).
-- Must drop first: Postgres cannot change RETURNS TABLE columns via CREATE OR REPLACE.

DROP FUNCTION IF EXISTS public.get_expense_submitter_profiles(uuid, uuid[]);

CREATE FUNCTION public.get_expense_submitter_profiles(
  p_organization_id uuid,
  p_user_ids uuid[]
)
RETURNS TABLE(
  user_id uuid,
  name text,
  email text,
  balance numeric,
  employee_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    uid AS user_id,
    CASE
      WHEN COALESCE(p.is_active, true) = false AND p.name IS NOT NULL THEN p.name || ' (Former)'
      ELSE COALESCE(
        p.name,
        mapped.name,
        nullif(trim(au.raw_user_meta_data->>'name'), ''),
        nullif(trim(au.raw_user_meta_data->>'full_name'), ''),
        initcap(replace(split_part(au.email, '@', 1), '.', ' '))
      )
    END AS name,
    COALESCE(p.email, mapped.email, au.email, '') AS email,
    COALESCE(p.balance, mapped.balance, 0::numeric) AS balance,
    COALESCE(
      nullif(trim(p.employee_id), ''),
      nullif(trim(mapped.employee_id), ''),
      nullif(trim(substring(au.email from 'emp\.[^.]+\.([^.]+)\.')), '')
    ) AS employee_id
  FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS uid
  LEFT JOIN public.profiles p
    ON p.user_id = uid
   AND p.organization_id = p_organization_id
  LEFT JOIN auth.users au ON au.id = uid
  LEFT JOIN LATERAL (
    SELECT p2.name, p2.email, p2.balance, p2.employee_id
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
  'Expense list helper: profile name/email/employee_id, mapped re-import match, or auth metadata.';
