import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261005160000_tally_sync_jobs_phase2.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("tally_sync_jobs migration (Phase 2)", () => {
  it("defines admin-only helper distinct from daily_report_caller_can_view_v1", () => {
    expect(sql).toContain("tally_sync_admin_can_view_v1");
    expect(sql).toContain("m.role::text = 'admin'");
    expect(sql).not.toContain("cashier_accountant_mode");
  });

  it("create_tally_sync_job_v1 rejects anon and uses 42501 for non-admin", () => {
    expect(sql).toContain("create_tally_sync_job_v1");
    expect(sql).toContain("'not permitted to create tally sync jobs' USING ERRCODE = '42501'");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public.create_tally_sync_job_v1[\s\S]*FROM anon/);
  });

  it("validates report_type enum", () => {
    expect(sql).toContain("'claim_verification'");
    expect(sql).toContain("'daily_project_report'");
    expect(sql).toContain("unsupported report type");
  });

  it("RLS SELECT uses admin helper only", () => {
    expect(sql).toContain('ON public.tally_sync_jobs FOR SELECT');
    expect(sql).toContain("tally_sync_admin_can_view_v1(organization_id)");
  });

  it("new jobs insert with status queued (Phase 2 never auto-completes)", () => {
    expect(sql).toContain("DEFAULT 'queued'");
    expect(sql).toMatch(/'queued'\s*\)/);
  });
});
