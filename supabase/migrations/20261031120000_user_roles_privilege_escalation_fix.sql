-- DOC-158 / security: close the privilege-escalation paths found while auditing public.user_roles (2026-10-24).
--
-- Verified on an isolated copy of the real Production schema (policies, grants, triggers; synthetic users only):
--   * any signed-in user could INSERT / UPDATE their OWN user_roles row to 'admin' / 'cashier' ("Users can insert/update their own roles"),
--     and "Admins can manage roles" (has_role(uid(),'admin'), ALL, NOT organization-scoped) then let that user insert / update / delete the
--     role rows of users in EVERY organization;
--   * any signed-in user could UPDATE profiles.is_master_admin = true on their OWN row ("Users can update their own profile" has no column
--     limit). is_master_admin() then returned true: they saw every organization and every profile, and could insert master_admin_memberships;
--   * the same self-update let a user edit their own balance, supervisor, cashier assignment, employee id, e-mail and active flag;
--   * any org admin or managed-profile cashier could flip is_master_admin on other users, and an org admin could rewrite other
--     organizations' user_roles rows.
--
-- Principles of the fix:
--   * READ stays as the application needs it (no SELECT policy is touched).
--   * user_roles WRITES: only an active administrator of the TARGET user's organization (existing restore policies) + server paths
--     (service_role, and the SECURITY DEFINER membership-sync trigger, which run as the table owner and bypass RLS).
--   * profiles: a BEFORE trigger guards the privileged columns for direct API callers only (current_user = authenticated / anon). SECURITY
--     DEFINER functions, service_role and the superuser are unaffected, so money RPCs, edge functions and sync triggers keep working.
--   * No applied migration is edited; this file only DROPs / ADDs what it names and is safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. user_roles: remove self-service and global-admin write policies; add an org-scoped DELETE
-- ---------------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert their own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users can update their own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can manage roles"          ON public.user_roles;

-- The two existing org-scoped policies stay exactly as they are:
--   "Admins can insert user_roles in their org for restore"  (INSERT, WITH CHECK: target belongs to an org the caller administers)
--   "Admins can update user_roles in their org for restore"  (UPDATE, USING/WITH CHECK: same)
-- The old global ALL policy also covered DELETE, so an org-scoped equivalent keeps restore / cleanup flows working.
DROP POLICY IF EXISTS "Org admins can delete user_roles in their org" ON public.user_roles;
CREATE POLICY "Org admins can delete user_roles in their org" ON public.user_roles
  FOR DELETE TO authenticated
  USING (user_id IN (
    SELECT om.user_id
      FROM public.organization_memberships om
     WHERE om.organization_id IN (
       SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid() AND o2.role = 'admin'::public.app_role AND o2.is_active = true)));

-- Least privilege: anonymous callers never write role data; nobody but the owner needs TRUNCATE (it bypasses RLS).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_roles               FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.master_admin_memberships FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.user_roles               FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.master_admin_memberships FROM authenticated;
REVOKE TRUNCATE ON public.profiles                 FROM authenticated, anon;
REVOKE TRUNCATE ON public.organization_memberships FROM authenticated, anon;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. admin_reset_user_password(): a dead function (no caller anywhere) that only echoed another user's e-mail to anyone holding a
--    legacy 'admin' role, across organizations. It resets nothing. Remove API access; the owner and service_role keep it.
-- ---------------------------------------------------------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_reset_user_password(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.admin_reset_user_password(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. profiles: guard privileged columns for DIRECT API callers
-- ---------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_master boolean;
BEGIN
  -- Only direct PostgREST callers are restricted. SECURITY DEFINER functions (money RPCs, sync triggers), edge functions
  -- (service_role) and operators run as other roles and are not affected.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  v_master := public.is_master_admin();

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_master_admin, false) AND NOT v_master THEN
      RAISE EXCEPTION 'only a master administrator may create a master-admin profile' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_master_admin IS DISTINCT FROM OLD.is_master_admin AND NOT v_master THEN
    RAISE EXCEPTION 'only a master administrator may change the master-admin flag' USING ERRCODE = '42501';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id AND NOT v_master THEN
    RAISE EXCEPTION 'a profile cannot be moved to another organization from the client' USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'a profile cannot be re-assigned to another user' USING ERRCODE = '42501';
  END IF;

  -- Editing your OWN profile (not as an administrator of your organization): presentation settings only.
  IF auth.uid() = OLD.user_id AND NOT v_master AND NOT public.is_org_admin(OLD.organization_id) THEN
    IF NEW.balance                      IS DISTINCT FROM OLD.balance
    OR NEW.is_active                    IS DISTINCT FROM OLD.is_active
    OR NEW.deactivated_at               IS DISTINCT FROM OLD.deactivated_at
    OR NEW.employee_id                  IS DISTINCT FROM OLD.employee_id
    OR NEW.email                        IS DISTINCT FROM OLD.email
    OR NEW.reporting_engineer_id        IS DISTINCT FROM OLD.reporting_engineer_id
    OR NEW.assigned_cashier_id          IS DISTINCT FROM OLD.assigned_cashier_id
    OR NEW.cashier_assigned_engineer_id IS DISTINCT FROM OLD.cashier_assigned_engineer_id
    OR NEW.cashier_assigned_location_id IS DISTINCT FROM OLD.cashier_assigned_location_id THEN
      RAISE EXCEPTION 'you can change your name, language and notification settings; other profile fields are managed by an administrator' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_profile_privileged_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS aaa_guard_profile_privileged_columns ON public.profiles;
-- Named so it runs BEFORE the other triggers (alphabetical order): a refused change never reaches them.
CREATE TRIGGER aaa_guard_profile_privileged_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_columns();

COMMIT;
