import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { decideDelivery } from "@/lib/tallyMapping/deliveryDecision";
import { mapPreparedJobItems } from "@/lib/tallyMapping/pipeline";
import { accountingExpenseKey } from "@/lib/tallyMapping/identities";
import { escapeXmlText } from "@/lib/tallyMapping/xml/escape";
import {
  ORG_A,
  ORG_B,
  EXP_E123,
  claimApprovalItem,
  claimVerificationItem,
  dailyProjectItem,
  detailedExpenseDeductionItem,
} from "@/lib/tallyMapping/__fixtures__/synthetic";

const migrationSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261006120000_tally_delivery_state_phase4.sql"),
  "utf-8",
);

function expenseVouchers(result: ReturnType<typeof mapPreparedJobItems>) {
  return result.commands.filter(
    (c) => c.kind === "voucher" && c.voucher.voucher_type === "PesoWise Expense",
  );
}

function assertWellFormedXml(xml: string) {
  expect(xml.startsWith("<?xml")).toBe(true);
  expect(xml).toContain("<ENVELOPE>");
  expect(xml).not.toMatch(/[^&]&[^#a-zA-Z]/);
  expect(xml).not.toContain("<test>");
}

describe("Phase 4 migration contract", () => {
  it("defines tally_delivery_state with org-scoped primary key", () => {
    expect(migrationSql).toContain("tally_delivery_state");
    expect(migrationSql).toContain("PRIMARY KEY (organization_id, delivery_key)");
    expect(migrationSql).toContain("tally_org_connector_config");
  });
});

describe("delivery decisions", () => {
  it("CREATE / SKIP / UPDATE / cancel_planned", () => {
    const state = new Map<string, { organization_id: string; delivery_key: string; delivery_kind: string; last_content_hash: string | null; tally_remote_id: null; last_action: "pending"; last_job_id: null; peso_deleted_at: null; cancel_strategy: null }>();
    expect(decideDelivery("k1", "h1", state)).toBe("create");
    state.set("k1", {
      organization_id: ORG_A,
      delivery_key: "k1",
      delivery_kind: "accounting_expense",
      last_content_hash: "h1",
      tally_remote_id: null,
      last_action: "pending",
      last_job_id: null,
      peso_deleted_at: null,
      cancel_strategy: null,
    });
    expect(decideDelivery("k1", "h1", state)).toBe("skip");
    expect(decideDelivery("k1", "h2", state)).toBe("update");
    expect(decideDelivery("k1", "h2", state, true)).toBe("cancel_planned");
  });
});

describe("cross-report deduplication — expense E123", () => {
  it("does not emit four accounting vouchers for one expense across four reports", () => {
    const items = [
      claimVerificationItem("hash-row-v1"),
      claimApprovalItem("hash-row-v2"),
      detailedExpenseDeductionItem("hash-row-v3"),
      dailyProjectItem(),
    ];
    const result = mapPreparedJobItems(items, {
      organization_id: ORG_A,
      job_id: "job-1",
    });
    expect(expenseVouchers(result).length).toBe(1);
    expect(result.accounting_voucher_count).toBe(1);
    const metaCount = result.commands.filter((c) => c.kind === "report_metadata").length;
    expect(metaCount).toBe(4);
  });
});

describe("organization isolation", () => {
  it("uses distinct accounting keys per org for same expense id string", () => {
    expect(accountingExpenseKey(ORG_A, EXP_E123)).not.toBe(accountingExpenseKey(ORG_B, EXP_E123));
  });
});

describe("XML serialization", () => {
  it("escapes injection-prone characters", () => {
    expect(escapeXmlText(`A & B <tag> "x"`)).toBe("A &amp; B &lt;tag&gt; &quot;x&quot;");
  });

  it("produces deterministic batched XML", () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      ...claimVerificationItem(`h-${i}`),
      seq: i + 1,
      source_key: `${ORG_A}:expense:${i.toString().padStart(8, "0")}-0000-0000-0000-000000000001`,
      payload: {
        ...claimVerificationItem().payload,
        expense_id: `${i.toString().padStart(8, "0")}-0000-0000-0000-000000000001`,
        payload: {
          ...(claimVerificationItem().payload.payload as Record<string, unknown>),
          id: `${i.toString().padStart(8, "0")}-0000-0000-0000-000000000001`,
        },
      },
    }));
    const a = mapPreparedJobItems(many, { organization_id: ORG_A, job_id: "j", batch_size: 50 });
    const b = mapPreparedJobItems(many, { organization_id: ORG_A, job_id: "j", batch_size: 50 });
    expect(a.xml_batches.length).toBeGreaterThan(1);
    expect(a.xml_batches[0].xml).toBe(b.xml_batches[0].xml);
    for (const batch of a.xml_batches) assertWellFormedXml(batch.xml);
  });

  it("handles zero-row job", () => {
    const result = mapPreparedJobItems([], { organization_id: ORG_A, job_id: "empty" });
    expect(result.commands.length).toBe(0);
    expect(result.xml_batches.length).toBe(1);
    expect(result.xml_batches[0].message_count).toBe(0);
    assertWellFormedXml(result.xml_batches[0].xml);
  });

  it("retains Unicode in escaped metadata JSON", () => {
    const result = mapPreparedJobItems([claimVerificationItem()], {
      organization_id: ORG_A,
      job_id: "j",
    });
    const xml = result.xml_batches[0].xml;
    assertWellFormedXml(xml);
    expect(xml).toContain("Unicode note");
  });
});

describe("SKIP unchanged delivery", () => {
  it("skips voucher when hash matches delivery state", () => {
    const acctKey = accountingExpenseKey(ORG_A, EXP_E123);
    const result = mapPreparedJobItems([claimVerificationItem("same-hash")], {
      organization_id: ORG_A,
      job_id: "j",
      delivery_state: [
        {
          organization_id: ORG_A,
          delivery_key: acctKey,
          delivery_kind: "accounting_expense",
          last_content_hash: "same-hash",
          tally_remote_id: "tally-guid-1",
          last_action: "create",
          last_job_id: "old-job",
          peso_deleted_at: null,
          cancel_strategy: null,
        },
      ],
    });
    expect(expenseVouchers(result).length).toBe(0);
    expect(result.decisions.some((d) => d.delivery_key === acctKey && d.action === "skip")).toBe(true);
  });
});
