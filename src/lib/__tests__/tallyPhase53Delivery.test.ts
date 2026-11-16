import { describe, expect, it } from "vitest";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { metadataVersionLedgerName, reportMetadataDeliveryKey, tallyMetadataDeliveryHash } from "@/lib/tallyMapping/identities";
import { contentHash } from "@/lib/tallySync/contentHash";
import { stableStringify } from "@/lib/tallySync/contentHash";

const ORG = "33333333-3333-3333-3333-333333333333";
const SOURCE = `${ORG}:daily_row:2026-10-06|44444444-4444-4444-4444-444444444444|55555555-5555-5555-5555-555555555555`;

async function dailyItem(remarks: string) {
  const row = {
    track_date: "2026-10-06",
    user_id: "44444444-4444-4444-4444-444444444444",
    project_id: "55555555-5555-5555-5555-555555555555",
    project_name: "Phase 5.3 Synthetic Project",
    location: "TEST-NO-ACCT",
    remarks,
    costs: { synthetic: 0 },
    percent: { synthetic: 0 },
    source_expenses: [],
    phase53: { test: "A", token: remarks, source: "production_mapper_serializer" },
  };
  return {
    seq: 1,
    source_type: "daily_report_row" as const,
    source_key: SOURCE,
    content_hash: await contentHash(row),
    payload: {
      organization_id: ORG,
      report_type: "daily_project_report" as const,
      track_date: "2026-10-06",
      user_id: row.user_id,
      project_id: row.project_id,
      row,
    },
  };
}

describe("Phase 5.3 delivery decisions", () => {
  it("SKIP emits no metadata ledger command when hash matches delivery state", async () => {
    const item = await dailyItem("phase53-test-a-controlled-create");
    const metaKey = reportMetadataDeliveryKey(ORG, "daily_project_report", SOURCE);
    const mapped = mapPreparedJobItems([item], {
      organization_id: ORG,
      job_id: "t",
      delivery_state: [
        {
          organization_id: ORG,
          delivery_key: metaKey,
          delivery_kind: "report_metadata",
          last_content_hash: tallyMetadataDeliveryHash(item.content_hash),
          tally_remote_id: metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(item.content_hash)),
          last_action: "create",
          last_job_id: "prior",
          peso_deleted_at: null,
          cancel_strategy: null,
        },
      ],
    });
    expect(mapped.commands.some((c) => c.kind === "report_metadata")).toBe(false);
    expect(mapped.decisions.find((d) => d.delivery_key === metaKey)?.action).toBe("skip");
  });

  it("UPDATE alters same ledger name when hash changes", async () => {
    const itemA = await dailyItem("phase53-test-a-controlled-create");
    const itemC = await dailyItem("phase53-test-c-controlled-alter");
    const metaKey = reportMetadataDeliveryKey(ORG, "daily_project_report", SOURCE);
    expect(itemC.content_hash).not.toBe(itemA.content_hash);

    const mapped = mapPreparedJobItems([itemC], {
      organization_id: ORG,
      job_id: "t2",
      delivery_state: [
        {
          organization_id: ORG,
          delivery_key: metaKey,
          delivery_kind: "report_metadata",
          last_content_hash: tallyMetadataDeliveryHash(itemA.content_hash),
          tally_remote_id: metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(itemA.content_hash)),
          last_action: "create",
          last_job_id: "prior",
          peso_deleted_at: null,
          cancel_strategy: null,
        },
      ],
    });
    const meta = mapped.commands.find((c) => c.kind === "report_metadata");
    expect(meta?.kind).toBe("report_metadata");
    if (meta?.kind === "report_metadata") {
      expect(meta.metadata.action).toBe("create");
      expect(meta.metadata.ledger_name).toContain("PW-META-");
    }
  });

  it("metadata JSON omits undefined field keys", () => {
    const json = stableStringify({ a: 1, voucher_no: undefined, b: "x" });
    expect(json).not.toContain("undefined");
    expect(json).toBe('{"a":1,"b":"x"}');
  });
});
