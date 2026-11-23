import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261007140000_tally_quarantine_smoke_batches.sql"),
  "utf-8",
);

const claimSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261007120000_tally_connector_phase5.sql"),
  "utf-8",
);

describe("Quarantine smoke batches migration", () => {
  it("defines admin quarantine RPC (skipped terminal state)", () => {
    expect(sql).toContain("admin_quarantine_tally_delivery_batches_v1");
    expect(sql).toContain("SET status = 'skipped'");
    expect(sql).toContain("Superseded after Phase 5");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, service_role/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO authenticated/i);
  });

  it("connector claim only selects pending batches (skipped never claimed)", () => {
    const claimBlock = claimSql.slice(claimSql.indexOf("connector_claim_delivery_batch_v1"));
    expect(claimBlock).toMatch(/AND b\.status = 'pending'/);
  });
});
