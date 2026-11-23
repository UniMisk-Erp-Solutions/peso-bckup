import type { TallySyncReportType } from "@/lib/tallyReportTypes";

/** TDL report / menu identifiers (must match tally-extension/tdl/*.tdl). */
export const TALLY_UI = {
  menu: "PW Reports Menu",
  gatewayKey: "O",
  reports: {
    claim_verification: {
      list: "PW Claim Verification List",
      detail: "PW Claim Verification Detail",
      menuKey: "V",
      title: "Claim Verification List",
    },
    claim_approval: {
      list: "PW Claim Approval List",
      detail: "PW Claim Approval Detail",
      menuKey: "A",
      title: "Claim Approval List",
    },
    detailed_expense: {
      list: "PW Detailed Expense List",
      detail: "PW Detailed Expense Detail",
      menuKey: "E",
      title: "Detailed Expense Report",
    },
    daily_project_report: {
      list: "PW Daily Project List",
      detail: "PW Daily Project Detail",
      menuKey: "D",
      title: "Daily Project Report",
    },
  },
} as const;

export type TallyUiReportType = keyof typeof TALLY_UI.reports;

export type TallyListColumn = {
  id: string;
  label: string;
  /** Pipe column index (1-based) in PESOWISE_REPORT_FLAT_ROW, when applicable. */
  flatIndex?: number;
  /** Persisted typed UDF used directly by the Tally list. */
  udf?: string;
  align: "left" | "right";
  width: number;
};

/** Fixed claim columns follow PesoWise export order (custom columns remain outside the fixed TDL grid). */
export const CLAIM_LIST_COLUMNS: TallyListColumn[] = [
  { id: "employee", label: "User", flatIndex: 1, align: "left", width: 18 },
  { id: "employee_id", label: "Employee ID", flatIndex: 2, align: "left", width: 13 },
  { id: "email", label: "Employee Email", flatIndex: 3, align: "left", width: 24 },
  { id: "transaction_number", label: "Transaction #", flatIndex: 4, align: "left", width: 14 },
  { id: "title", label: "Title", flatIndex: 5, align: "left", width: 20 },
  { id: "purpose", label: "Purpose", flatIndex: 6, align: "left", width: 24 },
  { id: "destination", label: "Destination", flatIndex: 7, align: "left", width: 18 },
  { id: "batch_ref", label: "Batch", flatIndex: 8, align: "left", width: 16 },
  { id: "category", label: "Expense Type", flatIndex: 9, align: "left", width: 14 },
  { id: "trip_start", label: "Bill Date", flatIndex: 10, align: "left", width: 11 },
  { id: "trip_end", label: "Trip End", flatIndex: 11, align: "left", width: 11 },
  { id: "amount", label: "Bill Amount", flatIndex: 12, align: "right", width: 12 },
  { id: "status", label: "Status", flatIndex: 13, align: "left", width: 16 },
  { id: "manager_approval", label: "Manager Approval", flatIndex: 14, align: "left", width: 18 },
  { id: "ho_approval", label: "HO Approval", flatIndex: 15, align: "left", width: 16 },
  { id: "created", label: "Submitted On", flatIndex: 16, align: "left", width: 12 },
  { id: "opening_balance", label: "Opening Balance", flatIndex: 17, align: "right", width: 14 },
  { id: "closing_balance", label: "Closing Balance", flatIndex: 18, align: "right", width: 14 },
  { id: "lpo_number", label: "LPO Number", udf: "PESOWISE_CLAIM_LPO", align: "left", width: 16 },
];

export const CLAIM_APPROVAL_LIST_COLUMNS: TallyListColumn[] = CLAIM_LIST_COLUMNS;

export const CLAIM_DETAIL_FLAT_FIELDS: { label: string; flatIndex: number }[] = [
  { label: "User", flatIndex: 1 },
  { label: "Employee ID", flatIndex: 2 },
  { label: "Employee Email", flatIndex: 3 },
  { label: "Transaction #", flatIndex: 4 },
  { label: "Title", flatIndex: 5 },
  { label: "Purpose", flatIndex: 6 },
  { label: "Destination", flatIndex: 7 },
  { label: "Batch", flatIndex: 8 },
  { label: "Expense Type", flatIndex: 9 },
  { label: "LPO Number", flatIndex: 19 },
  { label: "Bill Date", flatIndex: 10 },
  { label: "Trip End", flatIndex: 11 },
  { label: "Bill Amount", flatIndex: 12 },
  { label: "Status", flatIndex: 13 },
  { label: "Manager Approval", flatIndex: 14 },
  { label: "HO Approval", flatIndex: 15 },
  { label: "Submitted On", flatIndex: 16 },
  { label: "Opening Balance", flatIndex: 17 },
  { label: "Closing Balance", flatIndex: 18 },
];

export const DETAILED_LIST_COLUMNS: TallyListColumn[] = [
  { id: "employee", label: "Employee", flatIndex: 1, align: "left", width: 18 },
  { id: "employee_code", label: "Employee ID", flatIndex: 2, align: "left", width: 14 },
  { id: "date", label: "Date", flatIndex: 3, align: "left", width: 11 },
  { id: "transaction", label: "Transaction #", flatIndex: 4, align: "left", width: 14 },
  { id: "title", label: "Title", flatIndex: 5, align: "left", width: 22 },
  { id: "event", label: "Type", flatIndex: 6, align: "left", width: 16 },
  { id: "category", label: "Expense Type", flatIndex: 7, align: "left", width: 14 },
  { id: "purpose", label: "Purpose", flatIndex: 8, align: "left", width: 24 },
  { id: "destination", label: "Destination", flatIndex: 9, align: "left", width: 18 },
  { id: "batch_ref", label: "Batch", flatIndex: 10, align: "left", width: 16 },
  { id: "from_location", label: "From location", flatIndex: 11, align: "left", width: 18 },
  { id: "project_id", label: "Project ID", flatIndex: 12, align: "left", width: 14 },
  { id: "project_name", label: "Project Name", flatIndex: 13, align: "left", width: 24 },
  { id: "project_unique_id", label: "Project Unique ID", flatIndex: 14, align: "left", width: 20 },
  { id: "to_location", label: "To location", flatIndex: 15, align: "left", width: 18 },
  { id: "credit", label: "Credit", flatIndex: 16, align: "right", width: 13 },
  { id: "debit", label: "Debit", flatIndex: 17, align: "right", width: 13 },
  { id: "note", label: "Notes", flatIndex: 18, align: "left", width: 24 },
  { id: "opening_balance", label: "Opening Balance", flatIndex: 19, align: "right", width: 14 },
  { id: "closing_balance", label: "Closing Balance", flatIndex: 20, align: "right", width: 14 },
];

export const DETAILED_DETAIL_FLAT_FIELDS: { label: string; flatIndex: number }[] = [
  { label: "Employee", flatIndex: 1 },
  { label: "Employee ID", flatIndex: 2 },
  { label: "Date", flatIndex: 3 },
  { label: "Transaction #", flatIndex: 4 },
  { label: "Title", flatIndex: 5 },
  { label: "Type", flatIndex: 6 },
  { label: "Expense Type", flatIndex: 7 },
  { label: "Purpose", flatIndex: 8 },
  { label: "Destination", flatIndex: 9 },
  { label: "Batch", flatIndex: 10 },
  { label: "From location", flatIndex: 11 },
  { label: "Project ID", flatIndex: 12 },
  { label: "Project Name", flatIndex: 13 },
  { label: "Project Unique ID", flatIndex: 14 },
  { label: "To location", flatIndex: 15 },
  { label: "Credit", flatIndex: 16 },
  { label: "Debit", flatIndex: 17 },
  { label: "Notes", flatIndex: 18 },
  { label: "Opening Balance", flatIndex: 19 },
  { label: "Closing Balance", flatIndex: 20 },
];

/** Daily flat row uses the exact 23 PesoWise report headers; list view uses a subset. */
export const DAILY_LIST_COLUMNS: TallyListColumn[] = [
  { id: "track_date", label: "Track Date", flatIndex: 1, align: "left", width: 11 },
  { id: "voucher_no", label: "Voucher No", flatIndex: 2, align: "left", width: 13 },
  { id: "project_id", label: "project id", flatIndex: 3, align: "left", width: 16 },
  { id: "project_name", label: "project name", flatIndex: 4, align: "left", width: 20 },
  { id: "employee", label: "Employee", flatIndex: 5, align: "left", width: 18 },
  { id: "employee_code", label: "Employee Code", flatIndex: 6, align: "left", width: 14 },
  { id: "location", label: "Location", flatIndex: 7, align: "left", width: 16 },
  { id: "total_resource", label: "Total Resource", flatIndex: 8, align: "left", width: 14 },
  { id: "food", label: "Food", flatIndex: 9, align: "left", width: 10 },
  { id: "overtime", label: "Over Time", flatIndex: 10, align: "left", width: 12 },
  { id: "presence", label: "Presence", flatIndex: 11, align: "left", width: 10 },
  { id: "remarks", label: "Remarks", flatIndex: 12, align: "left", width: 24 },
  { id: "other_remarks", label: "Other Remarks", flatIndex: 13, align: "left", width: 24 },
  { id: "petrol_cost", label: "Petrol Cost", flatIndex: 14, align: "right", width: 13 },
  { id: "material_cost", label: "Material Cost", flatIndex: 15, align: "right", width: 13 },
  { id: "travelling_cost", label: "Travelling Cost", flatIndex: 16, align: "right", width: 13 },
  { id: "phone_exp", label: "Phone Exp.", flatIndex: 17, align: "right", width: 13 },
  { id: "hotel_exp", label: "Hotel Exp.", flatIndex: 18, align: "right", width: 13 },
  { id: "transport_exp", label: "Transport Exp", flatIndex: 19, align: "right", width: 13 },
  { id: "contra_bill", label: "Contra Bill", flatIndex: 20, align: "right", width: 13 },
  { id: "other_exp", label: "Other Exp.", flatIndex: 21, align: "right", width: 13 },
  { id: "site_code", label: "Site Id/RO Code", flatIndex: 22, align: "left", width: 16 },
  { id: "percent", label: "percent", flatIndex: 23, align: "left", width: 10 },
];

/** Full Daily Project grid headers (PesoWise source). Detail view shows all. */
export const DAILY_DETAIL_SECTIONS: { section: string; fields: { label: string; flatIndex?: number; udf?: string }[] }[] = [
  {
    section: "GENERAL",
    fields: [
      { label: "Track Date", flatIndex: 1 },
      { label: "Voucher No.", flatIndex: 2 },
      { label: "Employee", flatIndex: 5 },
      { label: "Employee Code", flatIndex: 6 },
      { label: "Location", flatIndex: 7 },
      { label: "Total Resource", flatIndex: 8 },
      { label: "Food", flatIndex: 9 },
      { label: "Over Time", flatIndex: 10 },
      { label: "Presence", flatIndex: 11 },
      { label: "Remarks", flatIndex: 12 },
      { label: "Other Remarks", flatIndex: 13 },
    ],
  },
  {
    section: "PROJECT",
    fields: [
      { label: "Project ID", flatIndex: 3 },
      { label: "Project Name", flatIndex: 4 },
    ],
  },
  {
    section: "EXPENSE BREAKDOWN",
    fields: [
      { label: "Petrol Cost", flatIndex: 14 },
      { label: "Material Cost", flatIndex: 15 },
      { label: "Travelling Cost", flatIndex: 16 },
      { label: "Phone Exp.", flatIndex: 17 },
      { label: "Hotel Exp.", flatIndex: 18 },
      { label: "Transport Exp", flatIndex: 19 },
      { label: "Contra Bill", flatIndex: 20 },
      { label: "Other Exp.", flatIndex: 21 },
      { label: "Total Expense", udf: "computed_total" },
      { label: "Site Id/RO Code", flatIndex: 22 },
      { label: "Percent", flatIndex: 23 },
    ],
  },
  {
    section: "OTHER",
    fields: [{ label: "Other Remarks", flatIndex: 13 }],
  },
];

export const EMPTY_STATE_LINES = [
  "No PesoWise data available",
  "Sync this report from PesoWise to view it here.",
] as const;

export const PARSE_ERROR_LINES = ["PesoWise report data could not be loaded."] as const;

export function reportTypeForTdlFilter(reportType: TallySyncReportType): string {
  return reportType;
}

export function listColumnsForReportType(reportType: TallySyncReportType): TallyListColumn[] {
  switch (reportType) {
    case "claim_verification":
      return CLAIM_LIST_COLUMNS;
    case "claim_approval":
      return CLAIM_APPROVAL_LIST_COLUMNS;
    case "detailed_expense":
      return DETAILED_LIST_COLUMNS;
    case "daily_project_report":
      return DAILY_LIST_COLUMNS;
    default:
      return [];
  }
}

/** Sum daily cost columns 14–21 from flat row segments (matches TDL PW DPR Row Total). */
export function computeDailyRowTotalFromFlatParts(parts: string[]): number {
  let sum = 0;
  for (let i = 13; i <= 20; i++) {
    const n = Number(parts[i] ?? "");
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

export function computeDetailedRowAmount(parts: string[]): number {
  const credit = Number(parts[15] ?? "");
  const debit = Number(parts[16] ?? "");
  if (Number.isFinite(debit) && debit > 0) return debit;
  if (Number.isFinite(credit) && credit > 0) return credit;
  return 0;
}

export function computeClaimRowAmount(parts: string[]): number {
  const n = Number(parts[11] ?? "");
  return Number.isFinite(n) ? n : 0;
}
