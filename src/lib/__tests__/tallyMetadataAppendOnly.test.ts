import { describe, expect, it } from "vitest";
import {
  metadataVersionDeliveryKey,
  metadataVersionLedgerName,
  reportMetadataDeliveryKey,
  tallyMetadataDeliveryHash,
} from "@/lib/tallyMapping/identities";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { serializeCommand } from "@/lib/tallyMapping/xml/serialize";
import { claimVerificationItem, dailyProjectItem } from "@/lib/tallyMapping/__fixtures__/synthetic";

const ORG = "11111111-1111-1111-1111-111111111111";

describe("metadata append-only versioning", () => {
  it("deterministic physical name from K+H", () => {
    const item = claimVerificationItem("h1");
    const metaKey = reportMetadataDeliveryKey(ORG, "claim_verification", item.source_key);
    const h1 = "a".repeat(64);
    const h2 = "b".repeat(64);
    expect(metadataVersionLedgerName(metaKey, h1)).toBe(metadataVersionLedgerName(metaKey, h1));
    expect(metadataVersionLedgerName(metaKey, h1)).not.toBe(metadataVersionLedgerName(metaKey, h2));
    expect(metadataVersionLedgerName(metaKey, h1)).toMatch(/^PW-META-[a-f0-9]{12}-[a-f0-9]{12}$/);
  });

  it("first K+H → CREATE", () => {
    const item = claimVerificationItem("hash-one");
    const metaKey = reportMetadataDeliveryKey(ORG, "claim_verification", item.source_key);
    const r = mapPreparedJobItems([item], { organization_id: ORG, job_id: "j" });
    const meta = r.commands.find((c) => c.kind === "report_metadata");
    expect(meta?.kind).toBe("report_metadata");
    if (meta?.kind === "report_metadata") {
      expect(meta.metadata.action).toBe("create");
      expect(meta.metadata.ledger_name).toBe(metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(item.content_hash)));
    }
    expect(serializeCommand(meta!)).toContain('<LEDGER ACTION="Create"');
  });

  it("same K+H → SKIP (zero metadata commands)", () => {
    const item = claimVerificationItem("same");
    const metaKey = reportMetadataDeliveryKey(ORG, "claim_verification", item.source_key);
    const state = [
      {
        organization_id: ORG,
        delivery_key: metaKey,
        delivery_kind: "report_metadata",
        last_content_hash: tallyMetadataDeliveryHash(item.content_hash),
        tally_remote_id: metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(item.content_hash)),
        last_action: "create" as const,
        last_job_id: "j0",
        peso_deleted_at: null,
        cancel_strategy: null,
      },
    ];
    const r = mapPreparedJobItems([item], { organization_id: ORG, job_id: "j", delivery_state: state });
    expect(r.commands.filter((c) => c.kind === "report_metadata").length).toBe(0);
  });

  it("reconciles legacy raw hashes with a new append-only XML transport version", () => {
    const item = claimVerificationItem("legacy-xml-hash");
    const metaKey = reportMetadataDeliveryKey(ORG, "claim_verification", item.source_key);
    const legacyState = [{
      organization_id: ORG,
      delivery_key: metaKey,
      delivery_kind: "report_metadata",
      last_content_hash: item.content_hash,
      tally_remote_id: metadataVersionLedgerName(metaKey, item.content_hash),
      last_action: "create" as const,
      last_job_id: "legacy-job",
      peso_deleted_at: null,
      cancel_strategy: null,
    }];
    const mapped = mapPreparedJobItems([item], {
      organization_id: ORG,
      job_id: "repeat-sync",
      delivery_state: legacyState,
    });
    const metadata = mapped.commands.find((command) => command.kind === "report_metadata");
    expect(metadata?.kind).toBe("report_metadata");
    expect(mapped.decisions.find((decision) => decision.delivery_key === metaKey)?.action).toBe("update");
    if (metadata?.kind === "report_metadata") {
      expect(metadata.metadata.action).toBe("create");
      expect(metadata.metadata.ledger_name).not.toBe(metadataVersionLedgerName(metaKey, item.content_hash));
    }
  });

  it("same K + new H → new CREATE version (never Alter)", () => {
    const item = claimVerificationItem("new-hash");
    const metaKey = reportMetadataDeliveryKey(ORG, "claim_verification", item.source_key);
    const state = [
      {
        organization_id: ORG,
        delivery_key: metaKey,
        delivery_kind: "report_metadata",
        last_content_hash: tallyMetadataDeliveryHash("old-hash"),
        last_metadata_revision: 1,
        tally_remote_id: metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash("old-hash")),
        last_action: "create" as const,
        last_job_id: "j0",
        peso_deleted_at: null,
        cancel_strategy: null,
      },
    ];
    const r = mapPreparedJobItems([item], { organization_id: ORG, job_id: "j", delivery_state: state });
    const meta = r.commands.find((c) => c.kind === "report_metadata");
    expect(meta?.kind).toBe("report_metadata");
    if (meta?.kind === "report_metadata") {
      expect(meta.metadata.action).toBe("create");
      expect(meta.metadata.ledger_name).not.toBe(metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash("old-hash")));
      expect(meta.metadata.ledger_name).toBe(metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(item.content_hash)));
      const p = meta.metadata.payload as { metadata_revision?: number };
      expect(p.metadata_revision).toBe(2);
    }
    expect(serializeCommand(meta!)).not.toContain('ACTION="Alter"');
  });

  it("retry after delivered new H → SKIP", () => {
    const item = claimVerificationItem("v2");
    const metaKey = reportMetadataDeliveryKey(ORG, "claim_verification", item.source_key);
    const h = item.content_hash;
    const state = [
      {
        organization_id: ORG,
        delivery_key: metaKey,
        delivery_kind: "report_metadata",
        last_content_hash: tallyMetadataDeliveryHash(h),
        tally_remote_id: metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(h)),
        last_action: "create" as const,
        last_job_id: "j0",
        peso_deleted_at: null,
        cancel_strategy: null,
      },
    ];
    const r = mapPreparedJobItems([item], { organization_id: ORG, job_id: "j", delivery_state: state });
    expect(r.commands.filter((c) => c.kind === "report_metadata").length).toBe(0);
  });

  it("JSON includes metadata_version_ledger_name", () => {
    const item = claimVerificationItem("jk");
    const r = mapPreparedJobItems([item], { organization_id: ORG, job_id: "j" });
    const meta = r.commands.find((c) => c.kind === "report_metadata");
    if (meta?.kind === "report_metadata") {
      const p = meta.metadata.payload as { metadata_version_ledger_name?: string };
      expect(p.metadata_version_ledger_name).toBe(meta.metadata.ledger_name);
    }
  });

  it("version delivery key is stable per K+H", () => {
    const k = reportMetadataDeliveryKey(ORG, "claim_verification", `${ORG}:expense:x`);
    expect(metadataVersionDeliveryKey(k, "abc")).toBe(`${k}:content:abc`);
  });

  it("daily project still has no voucher", () => {
    const r = mapPreparedJobItems([dailyProjectItem()], { organization_id: ORG, job_id: "j" });
    expect(r.commands.filter((c) => c.kind === "voucher").length).toBe(0);
  });
});
