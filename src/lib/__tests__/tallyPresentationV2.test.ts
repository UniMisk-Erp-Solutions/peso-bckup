import { describe, expect, it } from "vitest";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import type { PreparedJobItem } from "@/lib/tallyMapping/types";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";

function claimItem(): PreparedJobItem {
  return {
    seq: 1,
    source_type: "expense",
    source_key: `${ORG}:expense:test-1`,
    content_hash: "abc123hash",
    payload: {
      organization_id: ORG,
      report_type: "claim_verification",
      expense_id: "exp-1",
      row: {
        user_id: "u1",
        category: "Travel",
        total_amount: 100,
        status: "pending",
        transaction_number: "TX1",
        purpose: "Trip",
        user_name: "Test User",
      },
    },
  };
}

describe("Tally presentation V2 (report-only)", () => {
  it("emits metadata ledgers only — no vouchers or expense masters", () => {
    const mapped = mapPreparedJobItems([claimItem()], {
      organization_id: ORG,
      job_id: "job-1",
      presentation_only: true,
      sync_run_id: "run-abc",
    });
    const kinds = mapped.commands.map((c) => c.kind);
    expect(kinds).not.toContain("voucher");
    expect(mapped.commands.filter((c) => c.kind === "master" && c.master.kind === "ledger")).toHaveLength(0);
    expect(mapped.commands.some((c) => c.kind === "report_metadata")).toBe(true);
    expect(mapped.accounting_voucher_count).toBe(0);
    const xml = mapped.xml_batches[0]?.xml ?? "";
    expect(xml).not.toContain("<VOUCHER");
    expect(xml).toContain("PESOWISE_REPORT_TYPE");
    expect(xml).toContain("claim_verification");
    expect(xml).toContain("PESOWISE_SYNC_RUN");
  });
});
