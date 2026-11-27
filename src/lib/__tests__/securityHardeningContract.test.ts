/**
 * DOC-167 structural contract for the 2026-11 penetration-test hardening.
 * Pins the properties that close findings F1-F12 so a later edit cannot quietly reopen them.
 * (Live behaviour is verified with scripts/security/audit-anon-surface.sql against the database.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf-8");
const sql = read("supabase/migrations/20261127100000_security_hardening_anon_surface_v1.sql").replace(/--.*$/gm, "");

describe("hardening migration", () => {
  it("F1: dev-login RPC is revoked from anon and authenticated", () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.list_organizations_for_dev_login\(\)\s+FROM PUBLIC, anon, authenticated/);
  });

  it("F4: member counts requires master admin and is not granted to anon", () => {
    expect(sql).toMatch(/get_organization_member_counts[\s\S]*is_master_admin\(\)/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_organization_member_counts\(uuid\[\]\) FROM PUBLIC, anon/);
  });

  it("F3: email->tenant lookup is no longer anonymous and the sign-in gate is rate limited", () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.get_tenant_sign_in_subdomain_for_email\(text\) FROM PUBLIC, anon/);
    expect(sql).toMatch(/_rpc_rate_limit_ok\(\s*'email_can_sign_in_on_tenant'/);
  });

  it("F5: the permissive transaction-sequence policy is dropped and writes are revoked", () => {
    expect(sql).toMatch(/DROP POLICY %I ON public\.organization_transaction_sequences/);
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.organization_transaction_sequences FROM authenticated/);
    expect(sql).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  it("F7: signup trigger has no default-org fallback and requires the server-only marker", () => {
    expect(sql).toMatch(/pw_provisioned/);
    expect(sql).not.toMatch(/slug\s*=\s*'default'/);
    expect(sql).not.toMatch(/496fb7f7/);
  });

  it("F6/F11/F12: anon loses all table and function access except the explicit allow-list", () => {
    expect(sql).toMatch(/REVOKE ALL ON ALL TABLES\s+IN SCHEMA public FROM anon/);
    expect(sql).toMatch(/GRANT INSERT ON TABLE public\.contact_leads TO anon/);
    const allow = sql.match(/FOREACH fn_sig IN ARRAY ARRAY\[([\s\S]*?)\]/)?.[1] ?? "";
    expect(allow).toMatch(/get_organization_by_subdomain/);
    expect(allow).toMatch(/get_employee_auth_email/);
    expect(allow).not.toMatch(/list_organizations_for_dev_login|member_counts|_admin_submit/);
  });

  it("F10: anon statement_timeout is capped", () => {
    expect(sql).toMatch(/ALTER ROLE anon SET statement_timeout/);
  });
});

describe("user-creating edge functions stamp the server-only marker", () => {
  it.each(["admin-create-user", "bulk-users-import"])("%s sets app_metadata.pw_provisioned", (fn) => {
    expect(read(`supabase/functions/${fn}/index.ts`)).toMatch(/app_metadata:\s*\{\s*pw_provisioned:\s*true\s*\}/);
  });
});

describe("frontend", () => {
  it("the developer tenant picker is never rendered in production builds", () => {
    expect(read("src/pages/Auth.tsx")).toMatch(/import\.meta\.env\.DEV \? <DevTenantSelector \/> : null/);
  });
});

describe("hardening migration v2 (tables without organization_id)", () => {
  const v2 = read("supabase/migrations/20261127110000_security_hardening_global_tables_v1.sql").replace(/--.*$/gm, "");

  it("legacy bank/bills/vehicle tables become master-admin only", () => {
    expect(v2).toMatch(/'bank_accounts', 'bills', 'booking_requested_vehicles'/);
    expect(v2).toMatch(/CREATE POLICY master_admin_only[\s\S]*is_master_admin\(\)/);
  });

  it("system_config can only be changed by a master admin", () => {
    expect(v2).toMatch(/system_config_master_admin_write[\s\S]*is_master_admin\(\)/);
  });

  it("the open revisions INSERT policy is dropped and client writes are revoked", () => {
    expect(v2).toMatch(/DROP POLICY IF EXISTS "SECURITY DEFINER RPC may insert revisions"/);
    expect(v2).toMatch(/REVOKE INSERT, UPDATE, DELETE[\s\S]*expense_form_field_branch_config_revisions\s+FROM authenticated/);
    expect(v2).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/i);
  });
});

describe("CAPTCHA wiring (DOC-168)", () => {
  const auth = read("src/pages/Auth.tsx");

  it("the login form checks the CAPTCHA token BEFORE the employee-ID -> e-mail lookup", () => {
    const check = auth.indexOf("isTurnstileConfigured() && !captchaToken");
    const lookup = auth.indexOf("await resolveAuthEmail(validated.identifier)");
    expect(check).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(check);
  });

  it.each(["src/components/Layout.tsx", "src/pages/UserManagement.tsx"])(
    "%s sends a Turnstile token with its password re-check so server-side CAPTCHA does not break it",
    (file) => {
      const code = read(file);
      expect(code).toMatch(/<AuthTurnstile/);
      expect(code).toMatch(/options: buildAuthCaptchaOptions\(/);
    },
  );

  it("CSP allows the Turnstile script and frame", () => {
    const csp = read("vercel.json");
    expect(csp).toMatch(/script-src[^"]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src[^"]*https:\/\/challenges\.cloudflare\.com/);
  });
});
