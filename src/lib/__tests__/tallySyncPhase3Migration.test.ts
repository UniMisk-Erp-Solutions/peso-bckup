import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261005170000_tally_sync_preparation_phase3.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("tally sync Phase 3 migration", () => {
  it("adds prepared lifecycle state (not auto-completed)", () => {
    expect(sql).toContain("'prepared'");
    expect(sql).toContain("prepared_at");
    expect(sql).toContain("prepared_item_count");
  });

  it("creates tally_sync_job_items with org isolation and unique source_key per job", () => {
    expect(sql).toContain("tally_sync_job_items");
    expect(sql).toContain("UNIQUE (job_id, source_key)");
    expect(sql).toContain("tally_sync_admin_can_view_v1(organization_id)");
  });

  it("worker RPCs are service_role only", () => {
    expect(sql).toContain("claim_tally_sync_job_v1");
    expect(sql).toContain("complete_tally_sync_preparation_v1");
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public.claim_tally_sync_job_v1[\s\S]*TO service_role/);
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.claim_tally_sync_job_v1(text, uuid) FROM PUBLIC");
    expect(sql).toContain("FROM anon, authenticated");
  });

  it("claim clears prior items and uses SKIP LOCKED", () => {
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("DELETE FROM public.tally_sync_job_items WHERE job_id = v_job.id");
  });

  it("complete marks prepared not completed", () => {
    expect(sql).toContain("SET status = 'prepared'");
    expect(sql).not.toMatch(/complete_tally_sync_preparation_v1[\s\S]*status = 'completed'/);
  });

  it("tally_expense_meta_batch_v1 exposes approval_tier and deleted_at", () => {
    expect(sql).toContain("tally_expense_meta_batch_v1");
    expect(sql).toContain("approval_tier");
    expect(sql).toContain("deleted_at");
  });

  it("freezes daily config on enqueue", () => {
    expect(sql).toContain("config_snapshot");
    expect(sql).toContain("daily_expense_report_config");
  });

  it("active dedupe excludes prepared jobs", () => {
    expect(sql).toMatch(/WHERE status IN \('queued', 'processing'\)/);
  });
});
