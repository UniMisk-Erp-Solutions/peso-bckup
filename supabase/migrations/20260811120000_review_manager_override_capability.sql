-- DOC-080 — Manager-override capability probe (additive, read-only)
--
-- A tiny discovery RPC the frontend calls at runtime to learn whether Manager
-- override server support is installed. It replaces the hard-coded
-- MANAGER_OVERRIDE_AVAILABLE flag: PROCEED for waiting rows is enabled only when
-- this returns ready=true, so the UI fails closed on any environment where the
-- override migration has not been applied.
--
-- Performs NO mutation, exposes NO sensitive data — it only reports whether the
-- override function exists. Executable by authenticated; denied to anon/public.

CREATE OR REPLACE FUNCTION public.review_manager_override_capabilities_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'contract', 'review-manager-override',
    'version', 1,
    'ready', EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'review_approve_expense_manager_override_v1'
        AND n.nspname = 'public'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.review_manager_override_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_manager_override_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.review_manager_override_capabilities_v1() TO authenticated;

COMMENT ON FUNCTION public.review_manager_override_capabilities_v1() IS
  'Read-only capability probe: returns {contract, version, ready} where ready is '
  'true only when review_approve_expense_manager_override_v1 is installed. The '
  'frontend gates the Manager-override PROCEED action on this, so it fails closed '
  'wherever the override is not applied. No mutation, no sensitive data.';

NOTIFY pgrst, 'reload schema';
