import { describe, expect, it } from "vitest";
import { describeInboundJob, isInboundActive, lastSuccessful, PWT_INBOUND_STATE_LABEL, type PwtInboundJob } from "../pwtInbound";

const j = (o: Partial<PwtInboundJob> = {}): PwtInboundJob => ({
  id: "1", status: "completed", tally_company: "C", created_at: "2026-10-17T10:00:00Z", completed_at: "2026-10-17T10:00:05Z",
  vouchers_fetched: 0, imported_count: 0, already_imported_count: 0, skipped_count: 0, unmatched_count: 0, failed_count: 0,
  flagged_count: 0, imported_amount: 0, progress_current: 0, progress_total: null, error: null, ...o,
});

describe("Sync from Tally job summaries", () => {
  it("queued/fetching/processing are active; the rest are final", () => {
    expect((["queued", "fetching", "processing"] as const).every(isInboundActive)).toBe(true);
    expect((["completed", "needs_attention", "failed", "cancelled"] as const).some(isInboundActive)).toBe(false);
  });
  it("explains every outcome, mentioning only what happened", () => {
    expect(describeInboundJob(j({ status: "fetching", progress_current: 5, progress_total: 10 }))).toContain("5 of 10");
    expect(describeInboundJob(j({ status: "queued" }), false)).toMatch(/offline/i);
    expect(describeInboundJob(j({ status: "failed", error: "TallyPrime is not reachable" }))).toBe("TallyPrime is not reachable");
    expect(describeInboundJob(j({ vouchers_fetched: 4, imported_count: 3, unmatched_count: 1, flagged_count: 2 })))
      .toBe("4 voucher(s) read · 3 imported · 1 employee(s) not matched · 2 flagged for reconciliation");
  });
  it("finds the last successful sync", () => {
    expect(lastSuccessful([j({ id: "a", status: "failed", completed_at: "2026-10-17T11:00:00Z" }), j({ id: "b" }), j({ id: "c" })])?.id).toBe("b");
    expect(lastSuccessful([j({ status: "failed" })])).toBeUndefined();
  });
  it("has a label for every non-imported state the database can record", () => {
    for (const s of ["unmatched", "ambiguous", "skipped", "failed", "changed_after_import", "deleted_in_tally"]) expect(PWT_INBOUND_STATE_LABEL[s]).toBeTruthy();
  });
});
