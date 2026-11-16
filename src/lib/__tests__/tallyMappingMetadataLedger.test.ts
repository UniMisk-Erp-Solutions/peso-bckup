import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PESOWISE_METADATA_GROUP_NAME,
  PESOWISE_METADATA_JSON_UDF_INDEX,
  metadataLedgerName,
  metadataVersionLedgerName,
  reportMetadataDeliveryKey,
  tallyMetadataDeliveryHash,
} from "@/lib/tallyMapping/identities";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { escapeXmlText } from "@/lib/tallyMapping/xml/escape";
import { serializeCommand } from "@/lib/tallyMapping/xml/serialize";
import {
  ORG_A,
  EXP_E123,
  claimApprovalItem,
  claimVerificationItem,
  dailyProjectItem,
  detailedExpenseDeductionItem,
} from "@/lib/tallyMapping/__fixtures__/synthetic";

function mapOne(item: ReturnType<typeof claimVerificationItem>, delivery_state?: Parameters<typeof mapPreparedJobItems>[1]["delivery_state"]) {
  return mapPreparedJobItems([item], {
    organization_id: ORG_A,
    job_id: "job-meta",
    delivery_state,
  });
}

function metadataCommands(result: ReturnType<typeof mapPreparedJobItems>) {
  return result.commands.filter((c) => c.kind === "report_metadata");
}

function metadataXml(result: ReturnType<typeof mapPreparedJobItems>) {
  return metadataCommands(result).map(serializeCommand).join("\n");
}

describe("metadata ledger architecture", () => {
  it("maps metadata to LEDGER XML, not metadata voucher", () => {
    const result = mapOne(claimVerificationItem("h1"));
    const xml = metadataXml(result);
    expect(xml).toContain("<LEDGER ACTION=\"Create\"");
    expect(xml).not.toContain("PesoWise Report Meta");
    expect(xml).not.toContain("<VOUCHER");
    expect(metadataCommands(result).length).toBe(1);
  });

  it("uses parent PesoWise Metadata and plain metadata UDF", () => {
    const xml = metadataXml(mapOne(claimVerificationItem("h2")));
    expect(xml).toContain(`<PARENT>${PESOWISE_METADATA_GROUP_NAME}</PARENT>`);
    expect(xml).toContain('UDF:PESOWISE_METADATA_JSON TYPE="String"');
    expect(xml).toContain("xmlns:UDF=\"TallyUDF\"");
    expect(xml).toContain("PESOWISE_REPORT_TYPE");
  });

  it("produces deterministic ledger names from delivery keys", () => {
    const key = reportMetadataDeliveryKey(ORG_A, "claim_verification", `${ORG_A}:expense:${EXP_E123}`);
    const a = metadataLedgerName(key);
    const b = metadataLedgerName(key);
    expect(a).toBe(b);
    expect(a.startsWith("PW-META-")).toBe(true);
  });

  it("different delivery keys produce different ledger names", () => {
    const k1 = reportMetadataDeliveryKey(ORG_A, "claim_verification", "a");
    const k2 = reportMetadataDeliveryKey(ORG_A, "claim_approval", "a");
    expect(metadataLedgerName(k1)).not.toBe(metadataLedgerName(k2));
  });

  it("SKIP omits metadata ledger command when hash unchanged", () => {
    const item = claimVerificationItem("same");
    const metaKey = reportMetadataDeliveryKey(ORG_A, "claim_verification", item.source_key);
    const result = mapOne(item, [
      {
        organization_id: ORG_A,
        delivery_key: metaKey,
        delivery_kind: "report_metadata",
        last_content_hash: tallyMetadataDeliveryHash("same"),
        tally_remote_id: "mid-1",
        last_action: "create",
        last_job_id: "j0",
        peso_deleted_at: null,
        cancel_strategy: null,
      },
    ]);
    expect(metadataCommands(result).length).toBe(0);
  });

  it("UPDATE creates new append-only version (CREATE, not Alter)", () => {
    const item = claimVerificationItem("new-hash");
    const metaKey = reportMetadataDeliveryKey(ORG_A, "claim_verification", item.source_key);
    const result = mapOne(item, [
      {
        organization_id: ORG_A,
        delivery_key: metaKey,
        delivery_kind: "report_metadata",
        last_content_hash: tallyMetadataDeliveryHash("old-hash"),
        tally_remote_id: metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash("old-hash")),
        last_action: "create",
        last_job_id: "j0",
        peso_deleted_at: null,
        cancel_strategy: null,
      },
    ]);
    const meta = metadataCommands(result)[0];
    expect(meta?.kind).toBe("report_metadata");
    if (meta?.kind === "report_metadata") {
      expect(meta.metadata.action).toBe("create");
      expect(meta.metadata.ledger_name).toBe(
        metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash(item.content_hash)),
      );
      expect(meta.metadata.ledger_name).not.toBe(
        metadataVersionLedgerName(metaKey, tallyMetadataDeliveryHash("old-hash")),
      );
    }
    expect(metadataXml(result)).toContain("<LEDGER ACTION=\"Create\"");
    expect(metadataXml(result)).not.toContain('ACTION="Alter"');
  });

  it("does not emit opening balance or ledger entry lines for metadata", () => {
    const xml = metadataXml(mapOne(claimVerificationItem("h3")));
    expect(xml).not.toContain("ALLLEDGERENTRIES");
    expect(xml).not.toContain("OPENINGBALANCE");
    expect(xml).not.toMatch(/AMOUNT>-?1\.00/);
  });

  it("escapes malicious XML in metadata JSON fields", () => {
    const item = claimVerificationItem("hx");
    const row = (item.payload.payload as Record<string, unknown>) ?? {};
    item.payload = {
      ...item.payload,
      payload: { ...row, purpose: "A & B <script> \"x\"" },
    };
    const xml = mapPreparedJobItems([item], { organization_id: ORG_A, job_id: "j" }).xml_batches[0].xml;
    expect(xml).toContain(escapeXmlText('A & B <script> "x"'));
    expect(xml).not.toMatch(/[^&]&[^#a-zA-Z]/);
  });

  it("retains Unicode in metadata JSON", () => {
    const xml = metadataXml(mapOne(claimVerificationItem("hu")));
    expect(xml).toContain("Unicode note");
  });

  it("does not recreate the shared PesoWise Metadata group for each report job", () => {
    const result = mapOne(claimVerificationItem("hg"));
    expect(result.commands.some((c) => c.kind === "master" && c.master.kind === "group"
      && c.master.display_name === "PesoWise Metadata")).toBe(false);
    expect(result.xml_batches[0].xml).not.toContain("<NAME> PesoWise Metadata</NAME>");
  });

  it("daily project emits metadata only — no expense voucher", () => {
    const result = mapPreparedJobItems([dailyProjectItem()], { organization_id: ORG_A, job_id: "j" });
    expect(result.commands.filter((c) => c.kind === "voucher").length).toBe(0);
    expect(metadataCommands(result).length).toBe(1);
    expect(result.commands.some((c) => c.kind === "master" && c.master.kind === "ledger")).toBe(false);
    expect(result.xml_batches[0].xml).not.toContain("PesoWise Employees");
  });

  it("daily project metadata XML includes TDL display UDFs", () => {
    const xml = metadataXml(
      mapPreparedJobItems([dailyProjectItem()], { organization_id: ORG_A, job_id: "j" }),
    );
    expect(xml).toContain("PESOWISE_REPORT_TYPE");
    expect(xml).toContain("daily_project_report");
    expect(xml).toContain("PESOWISE_DPR_TRACK_DATE");
    expect(xml).toContain("PESOWISE_REPORT_FLAT_ROW");
    expect(xml).toContain("PESOWISE_METADATA_JSON");
    expect(xml).toContain("15-03-2026");
    expect(xml).toContain("PESOWISE_DPR_EMPLOYEE");
    expect(xml).toContain("Ravi");
    expect(xml).toContain("PESOWISE_DPR_PROJECT_NAME");
    expect(xml).toContain("Highway Phase 2");
  });

  it("declares every metadata UDF emitted by all four report serializers", () => {
    const bootstrap = readFileSync("tally-extension/PesoWise-Bootstrap.tdl", "utf8");
    const declared = new Set(
      [...bootstrap.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*String\s*:\s*\d+\s*$/gm)]
        .map((match) => match[1]),
    );
    const items = [
      claimVerificationItem("udf-contract-cv"),
      claimApprovalItem("udf-contract-ca"),
      detailedExpenseDeductionItem("udf-contract-de"),
      dailyProjectItem(),
    ];
    const emitted = new Set(
      items.flatMap((item) => {
        const mapped = mapPreparedJobItems([item], { organization_id: ORG_A, job_id: "udf-contract" });
        return mapped.commands
          .filter((command) => command.kind === "report_metadata")
          .flatMap((command) => [...serializeCommand(command).matchAll(/<UDF:([A-Z][A-Z0-9_]*)\b/g)]
            .map((match) => match[1]));
      }),
    );

    expect([...emitted].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });

  it("cross-report dedupe: one expense voucher, four metadata ledgers", () => {
    const result = mapPreparedJobItems(
      [
        claimVerificationItem("h1"),
        claimApprovalItem("h2"),
        detailedExpenseDeductionItem("h3"),
        dailyProjectItem(),
      ],
      { organization_id: ORG_A, job_id: "j" },
    );
    expect(result.commands.filter((c) => c.kind === "voucher").length).toBe(1);
    expect(metadataCommands(result).length).toBe(4);
    const names = metadataCommands(result).map((c) =>
      c.kind === "report_metadata" ? c.metadata.ledger_name : "",
    );
    expect(new Set(names).size).toBe(4);
  });

  it("retry with same hash does not duplicate metadata commands", () => {
    const item = claimVerificationItem("stable");
    const metaKey = reportMetadataDeliveryKey(ORG_A, "claim_verification", item.source_key);
    const state = [
      {
        organization_id: ORG_A,
        delivery_key: metaKey,
        delivery_kind: "report_metadata",
        last_content_hash: tallyMetadataDeliveryHash("stable"),
        tally_remote_id: "x",
        last_action: "create" as const,
        last_job_id: "j",
        peso_deleted_at: null,
        cancel_strategy: null,
      },
    ];
    const r1 = mapPreparedJobItems([item], { organization_id: ORG_A, job_id: "j", delivery_state: state });
    expect(metadataCommands(r1).length).toBe(0);
  });

  it("includes metadata_delivery_key inside JSON payload", () => {
    const item = claimVerificationItem("hk");
    const metaKey = reportMetadataDeliveryKey(ORG_A, "claim_verification", item.source_key);
    const meta = metadataCommands(mapOne(item, []))[0];
    expect(meta?.kind).toBe("report_metadata");
    if (meta?.kind === "report_metadata") {
      expect(meta.metadata.payload.metadata_delivery_key).toBe(metaKey);
    }
  });
});
