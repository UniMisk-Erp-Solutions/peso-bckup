import { describe, expect, it } from "vitest";
import { expectedMetadataRevision, nextMetadataRevision } from "@/lib/tallyMapping/metadataRevision";
import type { DeliveryStateRow } from "@/lib/tallyMapping/types";

const K = "org:meta:claim_verification:row1";

function row(partial: Partial<DeliveryStateRow>): DeliveryStateRow {
  return {
    organization_id: "o",
    delivery_key: K,
    delivery_kind: "report_metadata",
    last_content_hash: "aaa",
    last_metadata_revision: 1,
    tally_remote_id: "PW-META-x",
    last_action: "create",
    last_job_id: "j",
    peso_deleted_at: null,
    cancel_strategy: null,
    ...partial,
  };
}

describe("metadata_revision (not content_hash ordering)", () => {
  it("first CREATE → revision 1", () => {
    expect(nextMetadataRevision(K, "create", new Map(), "h1")).toBe(1);
  });

  it("UPDATE → revision increments even if new hash sorts before old", () => {
    const state = new Map<string, DeliveryStateRow>([
      [
        K,
        row({
          last_content_hash: "ffff",
          last_metadata_revision: 3,
        }),
      ],
    ]);
    expect(nextMetadataRevision(K, "update", state, "0000")).toBe(4);
  });

  it("concurrent map: second writer gets higher revision after first ack state", () => {
    const afterFirstAck = row({ last_content_hash: "h1", last_metadata_revision: 1 });
    expect(expectedMetadataRevision(afterFirstAck, "h2")).toBe(2);
    const concurrentStale = row({ last_content_hash: "h0", last_metadata_revision: 1 });
    expect(expectedMetadataRevision(concurrentStale, "h2")).toBe(2);
    const afterSecondAck = row({ last_content_hash: "h2", last_metadata_revision: 2 });
    expect(expectedMetadataRevision(afterSecondAck, "h2")).toBe(2);
    expect(expectedMetadataRevision(afterSecondAck, "h3")).toBe(3);
  });

  it("revision sequence 1 → 2 → 3 for new hashes", () => {
    let s: DeliveryStateRow | undefined;
    expect(expectedMetadataRevision(s, "h1")).toBe(1);
    s = row({ last_content_hash: "h1", last_metadata_revision: 1 });
    expect(expectedMetadataRevision(s, "h1")).toBe(1);
    expect(expectedMetadataRevision(s, "h2")).toBe(2);
    s = row({ last_content_hash: "h2", last_metadata_revision: 2 });
    expect(expectedMetadataRevision(s, "h3")).toBe(3);
  });
});
