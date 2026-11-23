import { describe, expect, it } from "vitest";
import { buildClaimReportFlatRow, buildDetailedReportFlatRow } from "@/lib/tallyMapping/reportDisplayRows";
import {
  buildClaimReportFlatRow as buildEdgeClaimReportFlatRow,
  buildDetailedReportFlatRow as buildEdgeDetailedReportFlatRow,
} from "../../../supabase/functions/_shared/tallyMapping/reportDisplayRows.ts";

describe("reportDisplayRows", () => {
  it("builds claim flat row with 19 pipe segments, including LPO", () => {
    const row = buildClaimReportFlatRow(
      {
        user_name: "Ada",
        employee_id: "E1",
        user_email: "a@x.com",
        transaction_number: "T-9",
        title: "Trip",
        trip_start: "2026-03-15",
        trip_end: "2026-03-16",
        created_at: "2026-03-10",
        total_amount: 100,
        status: "verified",
        category: "Travel",
        lpo_number: "LPO-42",
      },
      "claim_verification",
    );
    const parts = row.split("|");
    expect(parts).toHaveLength(19);
    expect(parts[0]).toBe("Ada");
    expect(parts[9]).toBe("15-03-2026");
    expect(parts[14]).toBe("Pending");
    expect(parts[11]).toBe("100.00");
    expect(parts[18]).toBe("LPO-42");
  });

  it("builds detailed flat row in the 20-column PesoWise export order", () => {
    const row = buildDetailedReportFlatRow({
      employee_name: "Bob",
      employee_code: "B2",
      effective_date: "2026-01-02",
      credit: 50,
      debit: 0,
      opening_balance: 100,
      closing_balance: 150,
      event_label: "Expense",
    });
    expect(row.split("|")).toHaveLength(20);
    expect(row).toContain("Bob");
    expect(row).toContain("02-01-2026");
  });

  it("keeps Ajay CSV money, notes, and closing balance in their original columns", () => {
    const parts = buildDetailedReportFlatRow({
      employee_name: "Ajay Kumar",
      employee_code: "6928",
      effective_date: "2026-07-07",
      transaction_number: "02030",
      title: "medical test",
      event_label: "Expense Deduction",
      category: "Other ( Xerox, Printing, Courier, Stationery & Medical )",
      purpose: "medical test",
      destination: "Ahmedabad",
      credit: "",
      debit: "₹300.00",
      note: "",
      opening_balance: "₹0.00",
      closing_balance: "-₹300.00",
    }).split("|");

    expect(parts).toHaveLength(20);
    expect(parts).toEqual([
      "Ajay Kumar", "6928", "07-07-2026", "02030", "medical test", "Expense Deduction",
      "Other ( Xerox, Printing, Courier, Stationery & Medical )", "medical test", "Ahmedabad",
      "__PW_EMPTY__", "__PW_EMPTY__", "__PW_EMPTY__", "__PW_EMPTY__", "__PW_EMPTY__",
      "__PW_EMPTY__", "__PW_EMPTY__", "300.00", "__PW_EMPTY__", "0.00", "-300.00",
    ]);
  });

  it("renders explicit zero amounts while keeping missing amount cells blank", () => {
    const row = {
      credit: "₹0.00",
      debit: "",
      opening_balance: 0,
      closing_balance: "₹0.00",
    };
    const parts = buildDetailedReportFlatRow(row).split("|");

    expect(parts[15]).toBe("0.00");
    expect(parts[16]).toBe("__PW_EMPTY__");
    expect(parts[18]).toBe("0.00");
    expect(parts[19]).toBe("0.00");
    expect(buildEdgeDetailedReportFlatRow(row)).toBe(buildDetailedReportFlatRow(row));
  });

  it.each(["claim_verification", "claim_approval"] as const)(
    "%s keeps explicit zero amount and balances visible",
    (reportType) => {
      const row = { total_amount: "₹0.00", opening_balance: 0, closing_balance: "₹0.00" };
      const parts = buildClaimReportFlatRow(row, reportType).split("|");

      expect(parts[11]).toBe("0.00");
      expect(parts[16]).toBe("0.00");
      expect(parts[17]).toBe("0.00");
      expect(buildEdgeClaimReportFlatRow(row, reportType)).toBe(buildClaimReportFlatRow(row, reportType));
    },
  );
});
