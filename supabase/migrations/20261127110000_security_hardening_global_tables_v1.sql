-- =============================================================================
-- Security hardening v2 (DOC-167): tables that are NOT scoped by organization_id.
--
-- Review result (backup DB, 2026-11-27): 61 org-scoped tables leak 0 rows across
-- companies and 56 reject cross-company writes. The only cross-company gaps:
--   * bank_accounts / bills / booking_requested_vehicles (legacy car-rental
--     tables, no organization_id, unused by the app): readable by EVERY logged-in
--     user and writable by the admin/manager of ANY company (policies keyed on the
--     global user_roles table).
--   * system_config: writable by the admin of ANY company.
--   * expense_form_field_branch_config_revisions: INSERT policy "WITH CHECK (true)"
--     for role public + INSERT grant, so any logged-in user could forge revision
--     rows for any organization. The only legitimate writers are SECURITY DEFINER
--     functions whose owners bypass RLS.
-- Idempotent. Safe: the app does not read or write the three legacy tables.
-- =============================================================================

BEGIN;

-- 1. Legacy tables without an organization: master admin only.
DO $$
DECLARE
  tbl text;
  pol record;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['bank_accounts', 'bills', 'booking_requested_vehicles']
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;

    FOR pol IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, tbl);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY master_admin_only ON public.%I FOR ALL TO authenticated '
      'USING (public.is_master_admin()) WITH CHECK (public.is_master_admin())', tbl);

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', tbl);
    EXECUTE format('REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.%I FROM authenticated', tbl);
  END LOOP;
END $$;

-- 2. system_config: everyone signed in may read; only master admin may change.
DO $$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.system_config') IS NULL THEN
    RETURN;
  END IF;

  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'system_config'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.system_config', pol.policyname);
  END LOOP;

  ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

  CREATE POLICY system_config_read ON public.system_config
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY system_config_master_admin_write ON public.system_config
    FOR ALL TO authenticated
    USING (public.is_master_admin()) WITH CHECK (public.is_master_admin());

  REVOKE ALL ON TABLE public.system_config FROM PUBLIC, anon;
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.system_config FROM authenticated;
END $$;

-- 3. strategies: read-only reference list (Master Admin dashboard reads it).
DO $$
BEGIN
  IF to_regclass('public.strategies') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public.strategies FROM PUBLIC, anon;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE public.strategies FROM authenticated;
  GRANT SELECT ON TABLE public.strategies TO authenticated;
END $$;

-- 4. Branch-config revision log: written only by SECURITY DEFINER functions.
DO $$
BEGIN
  IF to_regclass('public.expense_form_field_branch_config_revisions') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "SECURITY DEFINER RPC may insert revisions"
    ON public.expense_form_field_branch_config_revisions;

  REVOKE ALL ON TABLE public.expense_form_field_branch_config_revisions FROM PUBLIC, anon;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
    ON TABLE public.expense_form_field_branch_config_revisions FROM authenticated;
  GRANT SELECT ON TABLE public.expense_form_field_branch_config_revisions TO authenticated;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
