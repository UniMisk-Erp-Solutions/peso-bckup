import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20261019100000_secure_report_scope_v1.sql"),
  "utf8",
);

describe("20261019100000_secure_report_scope_v1.sql (static guards)", () => {
  it("derives scope from auth.uid() in a SECURITY DEFINER function with a pinned search_path", () => {
    expect(sql).toMatch(/FUNCTION public\.get_my_report_scope_v1\(p_organization_id uuid\)/);
    expect(sql).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    expect(sql).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public'/);
  });

  it("intersects the browser-supplied ids with the server scope", () => {
    expect(sql).toMatch(/e\.user_id = ANY\(public\.get_my_report_scope_v1\(p_organization_id\)\)/);
    expect(sql).toMatch(/u = ANY\(v_scope\)/);
  });

  it("revokes PUBLIC and anon and grants authenticated + service_role only", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role/);
    expect(sql).not.toMatch(/TO anon/);
  });

  it("does not touch approval routing, review functions or feature flags", () => {
    for (const forbidden of [
      "review_approve_expense",
      "review_verify",
      "review_advance_expense_hierarchy_tier",
      "_expense_resolve_routing",
      "assigned_reviewer_id",
      "approval_tier",
      "INSERT INTO public.organization_features",
      "reporting_engineer_id =",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("restricts employees to detailed report types", () => {
    expect(sql).toMatch(/v_role = 'employee' AND p_report_type NOT IN \('detailed_expense', 'full_expense_detail'\)/);
  });
});
