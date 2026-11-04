/**
 * Structural guard for 20261031120000_user_roles_privilege_escalation_fix.sql.
 * Behaviour is proven against Postgres by supabase/tests/user_roles_security (run.sh); this pins the shape so an edit cannot quietly undo it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const MIG = "supabase/migrations/20261031120000_user_roles_privilege_escalation_fix.sql";
const sql = readFileSync(resolve(process.cwd(), MIG), "utf-8");
const code = sql.replace(/--.*$/gm, "");

describe("user_roles / profiles privilege-escalation fix", () => {
  it("drops the three unsafe user_roles write policies", () => {
    for (const p of ["Users can insert their own roles", "Users can update their own roles", "Admins can manage roles"]) {
      expect(code).toMatch(new RegExp(`DROP POLICY IF EXISTS "${p}"\\s+ON public\\.user_roles;`));
    }
  });

  it("never recreates a self-service or global-admin write policy on user_roles", () => {
    const created = [...code.matchAll(/CREATE POLICY "([^"]+)" ON public\.user_roles\s+FOR (\w+)/g)];
    expect(created.map((m) => m[2])).toEqual(["DELETE"]);
    const body = code.slice(code.indexOf('CREATE POLICY "Org admins can delete user_roles in their org"'), code.indexOf("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_roles"));
    expect(body).not.toMatch(/has_role\(/);
    expect(body).not.toMatch(/auth\.uid\(\)\s*=\s*user_id/);
    expect(body).toMatch(/o2\.role = 'admin'::public\.app_role AND o2\.is_active = true/);
  });

  it("does not touch SELECT policies (reads keep working)", () => {
    expect(code).not.toMatch(/(DROP|CREATE|ALTER) POLICY[^;]*FOR SELECT/i);
    expect(code).not.toMatch(/DROP POLICY IF EXISTS "(Admins and cashiers can view all roles|Cashiers can view admin roles|Engineers and employees can view cashier and admin roles|Users can view their own roles)"/);
  });

  it("revokes anonymous write access and TRUNCATE (which bypasses RLS)", () => {
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.user_roles\s+FROM anon;/);
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.master_admin_memberships FROM anon;/);
    expect(code).toMatch(/REVOKE TRUNCATE ON public\.profiles\s+FROM authenticated, anon;/);
  });

  it("removes API access to the dead admin_reset_user_password (cross-org e-mail disclosure)", () => {
    expect(code).toMatch(/REVOKE EXECUTE ON FUNCTION public\.admin_reset_user_password\(uuid, text, text\) FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.admin_reset_user_password\(uuid, text, text\) TO service_role;/);
  });

  describe("profiles guard trigger", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.guard_profile_privileged_columns"), code.indexOf("CREATE TRIGGER aaa_guard_profile_privileged_columns"));
    it("restricts DIRECT API callers only: definer functions, service_role and operators are exempt", () => {
      expect(fn).toMatch(/IF current_user NOT IN \('authenticated', 'anon'\) THEN\s+RETURN NEW;/);
      expect(fn).toMatch(/SECURITY INVOKER/);
    });
    it("only a master admin may change the master-admin flag or move a profile between organizations", () => {
      expect(fn).toMatch(/NEW\.is_master_admin IS DISTINCT FROM OLD\.is_master_admin AND NOT v_master/);
      expect(fn).toMatch(/NEW\.organization_id IS DISTINCT FROM OLD\.organization_id AND NOT v_master/);
      expect(fn).toMatch(/COALESCE\(NEW\.is_master_admin, false\) AND NOT v_master/);
    });
    it("a non-admin editing their own profile cannot touch balance, status, identity or assignments", () => {
      for (const col of ["balance", "is_active", "deactivated_at", "employee_id", "email", "reporting_engineer_id", "assigned_cashier_id", "cashier_assigned_engineer_id", "cashier_assigned_location_id"]) {
        expect(fn).toMatch(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`));
      }
      expect(fn).toMatch(/auth\.uid\(\) = OLD\.user_id AND NOT v_master AND NOT public\.is_org_admin\(OLD\.organization_id\)/);
    });
    it("self-service columns stay editable (name, language, notification settings are never restricted)", () => {
      expect(fn).not.toMatch(/OLD\.name|OLD\.preferred_language|OLD\.notification_settings/);
    });
    it("is created BEFORE INSERT OR UPDATE and sorts first among profiles triggers", () => {
      expect(code).toMatch(/CREATE TRIGGER aaa_guard_profile_privileged_columns\s+BEFORE INSERT OR UPDATE ON public\.profiles/);
    });
    it("is not executable by API roles", () => {
      expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.guard_profile_privileged_columns\(\) FROM PUBLIC, anon, authenticated;/);
    });
  });

  it("is transactional and does not rewrite any previously applied migration", () => {
    expect(code.trim().startsWith("BEGIN;")).toBe(true);
    expect(code.trim().endsWith("COMMIT;")).toBe(true);
    // a NEW file with the next free version: no other migration shares its version prefix
    const same = readdirSync(resolve(process.cwd(), "supabase/migrations")).filter((f) => f.startsWith("20261031120000"));
    expect(same).toEqual(["20261031120000_user_roles_privilege_escalation_fix.sql"]);
  });
});
