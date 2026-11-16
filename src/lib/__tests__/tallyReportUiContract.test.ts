import { describe, expect, it } from "vitest";
import {
  dedupeLatestMetadataRevisions,
  filterRowsByReportType,
  rowsForTallyReportDisplay,
  type MetadataLedgerDisplayRow,
} from "@/lib/tallyMapping/dedupeLatestMetadataRevisions";
import {
  CLAIM_LIST_COLUMNS,
  CLAIM_APPROVAL_LIST_COLUMNS,
  computeClaimRowAmount,
  computeDailyRowTotalFromFlatParts,
  computeDetailedRowAmount,
  DAILY_LIST_COLUMNS,
  DETAILED_LIST_COLUMNS,
  EMPTY_STATE_LINES,
  TALLY_UI,
} from "@/lib/tallyMapping/tallyReportUiContract";
import { buildClaimReportFlatRow, buildDetailedReportFlatRow } from "@/lib/tallyMapping/reportDisplayRows";
import { buildDailyProjectFlatRow } from "@/lib/tallyMapping/dailyProjectLedgerUdks";
import { buildMetadataV1 } from "@/lib/tallyMapping/metadataSchema";
import { ORG_A } from "@/lib/tallyMapping/__fixtures__/synthetic";
import { DAILY_PROJECT_REPORT_HEADERS } from "@/lib/dailyExpenseReportConfig";

const ORG = ORG_A;

function metaRow(
  overrides: Partial<MetadataLedgerDisplayRow> & Pick<MetadataLedgerDisplayRow, "metadata_delivery_key" | "metadata_revision" | "report_type">,
): MetadataLedgerDisplayRow {
  return {
    organization_id: ORG,
    content_hash: `h-${overrides.metadata_revision}`,
    ...overrides,
  };
}

function generateRows(count: number, reportType: MetadataLedgerDisplayRow["report_type"]): MetadataLedgerDisplayRow[] {
  const out: MetadataLedgerDisplayRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      metaRow({
        metadata_delivery_key: `${ORG}:${reportType}:key-${i % Math.max(1, Math.floor(count / 10))}`,
        metadata_revision: 1 + (i % 3),
        report_type: reportType,
      }),
    );
  }
  return out;
}

describe("tallyReportUiContract", () => {
  it("exposes four list report names and menu keys", () => {
    expect(TALLY_UI.reports.claim_verification.list).toBe("PW Claim Verification List");
    expect(TALLY_UI.reports.claim_approval.menuKey).toBe("A");
    expect(TALLY_UI.reports.detailed_expense.menuKey).toBe("E");
    expect(TALLY_UI.reports.daily_project_report.menuKey).toBe("D");
    expect(CLAIM_LIST_COLUMNS).toHaveLength(19);
    expect(CLAIM_APPROVAL_LIST_COLUMNS).toHaveLength(19);
    expect(DETAILED_LIST_COLUMNS).toHaveLength(20);
    expect(DAILY_LIST_COLUMNS).toHaveLength(23);
    expect(DAILY_LIST_COLUMNS.map((column) => column.label)).toEqual(DAILY_PROJECT_REPORT_HEADERS);
    expect(EMPTY_STATE_LINES).toHaveLength(2);
  });

  it("computes daily total from flat parts consistent with cost columns", () => {
    const meta = buildMetadataV1({
      organization_id: ORG,
      report_type: "daily_project_report",
      metadata_delivery_key: "k",
      metadata_version_ledger_name: "L",
      metadata_revision: 1,
      source_key: "s",
      content_hash: "abc",
      fields: { track_date: "2026-04-06", costs: { petrol_cost: 100, material_cost: 50 } },
    });
    const flat = buildDailyProjectFlatRow(meta, {
      "Track Date": "2026-04-06", "Voucher No": "V-1", "project id": "P-1",
      "project name": "P", Employee: "E", "Employee Code": "E-1", Location: "Site",
      "Total Resource": "5", Food: "6", "Over Time": "2", Presence: "P",
      Remarks: "Work", "Other Remarks": "Note", "Petrol Cost": "100",
      "Material Cost": "50", "Travelling Cost": "3", "Phone Exp.": "4",
      "Hotel Exp.": "5", "Transport Exp": "6", "Contra Bill": "7",
      "Other Exp.": "8", "Site Id/RO Code": "RO-1", percent: "100",
      project_name: "P", employee_name: "E", costs: { petrol_cost: 100, material_cost: 50 },
    }).split("|");
    expect(flat).toHaveLength(DAILY_PROJECT_REPORT_HEADERS.length);
    expect(flat[7]).toBe("5");
    expect(flat[8]).toBe("6");
    expect(flat[10]).toBe("P");
    expect(flat[13]).toBe("100");
    expect(flat[20]).toBe("8");
    expect(flat[21]).toBe("RO-1");
    expect(flat[22]).toBe("100");
    expect(computeDailyRowTotalFromFlatParts(flat)).toBe(183);
  });

  it("computes claim and detailed list amounts from flat rows", () => {
    const claim = buildClaimReportFlatRow({ total_amount: 250, status: "verified" }, "claim_verification").split("|");
    expect(computeClaimRowAmount(claim)).toBe(250);
    const det = buildDetailedReportFlatRow({ debit: 0, credit: 75 }).split("|");
    expect(computeDetailedRowAmount(det)).toBe(75);
  });
});

describe("dedupeLatestMetadataRevisions", () => {
  it("returns 0 rows for empty input", () => {
    expect(dedupeLatestMetadataRevisions([])).toEqual([]);
  });

  it("keeps single row", () => {
    const one = metaRow({
      metadata_delivery_key: "K1",
      metadata_revision: 2,
      report_type: "claim_verification",
    });
    expect(dedupeLatestMetadataRevisions([one])).toEqual([one]);
  });

  it("keeps max revision only per delivery key", () => {
    const rows = [
      metaRow({ metadata_delivery_key: "K1", metadata_revision: 1, report_type: "daily_project_report" }),
      metaRow({ metadata_delivery_key: "K1", metadata_revision: 3, report_type: "daily_project_report" }),
      metaRow({ metadata_delivery_key: "K1", metadata_revision: 2, report_type: "daily_project_report" }),
      metaRow({ metadata_delivery_key: "K2", metadata_revision: 1, report_type: "daily_project_report" }),
    ];
    const out = dedupeLatestMetadataRevisions(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.metadata_delivery_key === "K1")?.metadata_revision).toBe(3);
  });

  it.each([0, 1, 50, 500, 2500])("dedupes %i generated rows without cross-key bleed", (n) => {
    const rows = generateRows(n, "detailed_expense");
    const out = dedupeLatestMetadataRevisions(rows);
    const keys = new Set(out.map((r) => r.metadata_delivery_key));
    expect(out.length).toBe(keys.size);
    for (const k of keys) {
      const revs = rows.filter((r) => r.metadata_delivery_key === k).map((r) => r.metadata_revision);
      const max = Math.max(...revs);
      expect(out.find((r) => r.metadata_delivery_key === k)?.metadata_revision).toBe(max);
    }
  });

  it("does not mix report types in display helper", () => {
    const rows = [
      metaRow({ metadata_delivery_key: "K1", metadata_revision: 1, report_type: "claim_verification" }),
      metaRow({ metadata_delivery_key: "K2", metadata_revision: 1, report_type: "claim_approval" }),
      metaRow({ metadata_delivery_key: "K3", metadata_revision: 1, report_type: "daily_project_report" }),
    ];
    expect(rowsForTallyReportDisplay(rows, "claim_verification", ORG)).toHaveLength(1);
    expect(filterRowsByReportType(rows, "claim_approval")).toHaveLength(1);
  });

  it("rejects cross-org rows", () => {
    const rows = [metaRow({ metadata_delivery_key: "K", metadata_revision: 1, report_type: "claim_verification", organization_id: "other" })];
    expect(() => rowsForTallyReportDisplay(rows, "claim_verification", ORG)).toThrow(/Cross-org/);
  });
});
