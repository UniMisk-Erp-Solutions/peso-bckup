import { describe, expect, it } from "vitest";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { claimVerificationItem } from "@/lib/tallyMapping/__fixtures__/synthetic";
import { tallyMetadataDeliveryHash } from "@/lib/tallyMapping/identities";

const ORG = "11111111-1111-1111-1111-111111111111";

describe("delivery_updates on batches", () => {
  it("includes metadata_revision on first CREATE batch", () => {
    const item = claimVerificationItem("du1");
    const r = mapPreparedJobItems([item], { organization_id: ORG, job_id: "j" });
    expect(r.xml_batches.length).toBeGreaterThan(0);
    const updates = r.xml_batches.flatMap((b) => b.delivery_updates ?? []);
    const meta = updates.find((u) => u.delivery_kind === "report_metadata");
    expect(meta?.metadata_revision).toBe(1);
    expect(meta?.content_hash).toBe(tallyMetadataDeliveryHash(item.content_hash));
  });
});
