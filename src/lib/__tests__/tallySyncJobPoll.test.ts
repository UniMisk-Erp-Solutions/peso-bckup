import { describe, expect, it } from "vitest";
import {
  describeTallyImportNotConfirmed,
  describeTallySyncProgress,
  isTallyDeliveryComplete,
  tallyDeliverableBatchCount,
  tallyImportConfirmedInTally,
  type TallyBatchSummary,
  type TallySyncJobRow,
} from "@/lib/tallySyncJobPoll";

const job = (over: Partial<TallySyncJobRow>): TallySyncJobRow => ({
  id: "j",
  status: "completed",
  prepared_item_count: 100,
  error_message_safe: null,
  ...over,
});

describe("tallySyncJobPoll delivery progress", () => {
  it("reports a cancelled job as stopped before delivery", () => {
    expect(describeTallySyncProgress(job({ status: "cancelled" }), null)).toContain(
      "cancelled before delivery",
    );
  });

  it("ignores skipped empty chunk batches in deliverable total", () => {
    const b: TallyBatchSummary = {
      pending: 0,
      claimed: 0,
      delivered: 1,
      failed: 0,
      manual_review: 0,
      skipped: 3,
      total: 4,
      tally_masters_created: 1,
      tally_masters_altered: 0,
      tally_udf_refresh_unconfirmed: 0,
    };
    expect(tallyDeliverableBatchCount(b)).toBe(1);
    expect(isTallyDeliveryComplete({ id: "j", status: "delivering", prepared_item_count: 1, error_message_safe: null }, b)).toBe(true);
  });

  it("explains that rows matching saved sync state were not sent again", () => {
    const batches: TallyBatchSummary = {
      pending: 0,
      claimed: 0,
      delivered: 0,
      failed: 0,
      manual_review: 0,
      skipped: 1,
      total: 1,
      tally_masters_created: 0,
      tally_masters_altered: 0,
      tally_udf_refresh_unconfirmed: 0,
    };
    const msg = describeTallySyncProgress(job({ status: "completed" }), batches);
    expect(msg).toContain("No new data was sent");
    expect(msg).toContain("match content already recorded as synchronized");
    expect(msg).not.toContain("duplicates only");
  });

  it("tallyImportConfirmed when Tally reports created or altered", () => {
    const batches: TallyBatchSummary = {
      pending: 0,
      claimed: 0,
      delivered: 2,
      failed: 0,
      manual_review: 0,
      skipped: 0,
      total: 2,
      tally_masters_created: 0,
      tally_masters_altered: 3,
      tally_udf_refresh_unconfirmed: 0,
    };
    expect(tallyImportConfirmedInTally(job({}), batches)).toBe(true);
    expect(describeTallySyncProgress(job({ status: "completed" }), batches)).toContain(
      "clean import response",
    );
    expect(describeTallySyncProgress(job({ status: "completed" }), batches)).toContain("not been verified by read-back");
  });

  it("not confirmed when duplicate-only batches lack UDF refresh flag", () => {
    const batches: TallyBatchSummary = {
      pending: 0,
      claimed: 0,
      delivered: 2,
      failed: 0,
      manual_review: 0,
      skipped: 0,
      total: 2,
      tally_masters_created: 0,
      tally_masters_altered: 0,
      tally_udf_refresh_unconfirmed: 2,
    };
    expect(tallyImportConfirmedInTally(job({}), batches)).toBe(false);
    expect(describeTallyImportNotConfirmed(job({}), batches)).toContain("duplicate");
  });

  it("reports successful read-back counts after the import", () => {
    const batches: TallyBatchSummary = {
      pending: 0,
      claimed: 0,
      delivered: 1,
      failed: 0,
      manual_review: 0,
      skipped: 0,
      total: 1,
      tally_masters_created: 5,
      tally_masters_altered: 0,
      tally_udf_refresh_unconfirmed: 0,
      tally_readback_verified_batches: 1,
      tally_readback_unverified_batches: 0,
      tally_readback_expected: 5,
      tally_readback_found: 5,
    };
    expect(describeTallySyncProgress(job({ status: "completed" }), batches)).toContain(
      "read-back verified (5 report rows; 5 created, 0 altered)",
    );
  });
});
