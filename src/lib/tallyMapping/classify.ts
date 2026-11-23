import type { DataClass } from "./types";

const BALANCE_ACCOUNTING_EVENTS = new Set([
  "allocation",
  "manual_adjustment",
  "cash_transfer_in",
  "cash_transfer_out",
  "bank_transfer",
  "reversal",
  "correction",
  "historical_balance_update",
  "opening_credit",
  "balance_credit",
  "credit_reversal",
  "historical_balance_adjustment",
]);

/** Classify detailed-expense timeline rows for Tally mapping. */
export function classifyTimelineEvent(eventType: string): {
  dataClass: DataClass;
  emitsAccountingVoucher: boolean;
  linksExpenseAccounting: boolean;
} {
  if (eventType === "expense_deduction") {
    return {
      dataClass: "report_metadata",
      emitsAccountingVoucher: false,
      linksExpenseAccounting: true,
    };
  }
  if (BALANCE_ACCOUNTING_EVENTS.has(eventType)) {
    return {
      dataClass: "accounting",
      emitsAccountingVoucher: true,
      linksExpenseAccounting: false,
    };
  }
  return {
    dataClass: "derived_report",
    emitsAccountingVoucher: false,
    linksExpenseAccounting: false,
  };
}

export function managerApprovalLabel(reportType: string, status: string): string {
  if (reportType === "claim_approval") return "Verified";
  if (status === "verified") return "Verified";
  if (status === "level_1_verified") return "Level 1 Verified";
  if (status === "level_2_verified") return "Level 2 Verified";
  return status;
}

export function hoApprovalLabel(reportType: string): string {
  return reportType === "claim_approval" ? "Approved" : "Pending";
}
