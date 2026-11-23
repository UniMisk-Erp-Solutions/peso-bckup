import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const index = readFileSync(
  resolve(process.cwd(), "supabase/functions/run-tally-sync-job/index.ts"),
  "utf-8",
);

describe("run-tally-sync-job edge worker", () => {
  it("claims atomically and pages all four report sources", () => {
    expect(index).toContain("claim_tally_sync_job_v1");
    expect(index).toContain("report_expense_rows_v1");
    expect(index).toContain("report_detailed_expense_rows_v4");
    expect(index).toContain("report_daily_project_rows_v1");
  });

  it("applies Tally-only expense meta for deleted_at and R3", () => {
    expect(index).toContain("tally_expense_meta_batch_v1");
    expect(index).toContain("passesTallyExpenseFilters");
  });

  it("persists normalized chunks and completes preparation", () => {
    expect(index).toContain("store_tally_sync_job_items_chunk_v1");
    expect(index).toContain("complete_tally_sync_preparation_v1");
    expect(index).toContain("fail_tally_sync_job_v1");
  });

  it("auth accepts service role or user JWT inside handler", () => {
    expect(index).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(index).toContain("getUser");
  });
});
