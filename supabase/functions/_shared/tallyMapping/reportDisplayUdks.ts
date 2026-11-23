import { hoApprovalLabel, managerApprovalLabel } from "./classify.ts";
import type { LedgerDisplayUdf } from "./metaDisplayUdks.ts";

function formatTrackDateForTally(iso: unknown): string {
  const raw = String(iso ?? "").trim();
  const date = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return raw;
  const [year, month, day] = date.split("-");
  return `${day}-${month}-${year}`;
}

/** Dedicated typed UDF slots for the two expense report families. */
export const CLAIM_REPORT_UDF = {
  employee: ["PESOWISE_CLAIM_EMPLOYEE", "25031"],
  employee_id: ["PESOWISE_CLAIM_EMPLOYEE_ID", "25032"],
  email: ["PESOWISE_CLAIM_EMAIL", "25033"],
  transaction: ["PESOWISE_CLAIM_TRANSACTION", "25034"],
  title: ["PESOWISE_CLAIM_TITLE", "25035"],
  purpose: ["PESOWISE_CLAIM_PURPOSE", "25036"],
  destination: ["PESOWISE_CLAIM_DESTINATION", "25037"],
  batch: ["PESOWISE_CLAIM_BATCH", "25038"],
  category: ["PESOWISE_CLAIM_CATEGORY", "25039"],
  trip_start: ["PESOWISE_CLAIM_TRIP_START", "25040"],
  trip_end: ["PESOWISE_CLAIM_TRIP_END", "25041"],
  amount: ["PESOWISE_CLAIM_AMOUNT", "25042"],
  status: ["PESOWISE_CLAIM_STATUS", "25043"],
  manager_approval: ["PESOWISE_CLAIM_MANAGER", "25044"],
  ho_approval: ["PESOWISE_CLAIM_HO", "25045"],
  submitted_on: ["PESOWISE_CLAIM_SUBMITTED", "25046"],
  opening_balance: ["PESOWISE_CLAIM_OPENING", "25047"],
  closing_balance: ["PESOWISE_CLAIM_CLOSING", "25048"],
  lpo_number: ["PESOWISE_CLAIM_LPO", "25049"],
} as const;

export const DETAILED_EXPENSE_UDF = {
  employee: ["PESOWISE_DE_EMPLOYEE", "25050"],
  employee_code: ["PESOWISE_DE_EMPLOYEE_CODE", "25051"],
  date: ["PESOWISE_DE_DATE", "25052"],
  transaction: ["PESOWISE_DE_TRANSACTION", "25053"],
  title: ["PESOWISE_DE_TITLE", "25054"],
  event: ["PESOWISE_DE_EVENT", "25055"],
  category: ["PESOWISE_DE_CATEGORY", "25056"],
  purpose: ["PESOWISE_DE_PURPOSE", "25057"],
  destination: ["PESOWISE_DE_DESTINATION", "25058"],
  batch: ["PESOWISE_DE_BATCH", "25059"],
  from_location: ["PESOWISE_DE_FROM_LOCATION", "25072"],
  project_id: ["PESOWISE_DE_PROJECT_ID", "25073"],
  project_name: ["PESOWISE_DE_PROJECT_NAME", "25074"],
  project_unique_id: ["PESOWISE_DE_PROJECT_UNIQUE_ID", "25075"],
  to_location: ["PESOWISE_DE_TO_LOCATION", "25076"],
  credit: ["PESOWISE_DE_CREDIT", "25060"],
  debit: ["PESOWISE_DE_DEBIT", "25061"],
  note: ["PESOWISE_DE_NOTE", "25062"],
  opening_balance: ["PESOWISE_DE_OPENING", "25063"],
  closing_balance: ["PESOWISE_DE_CLOSING", "25064"],
} as const;

export const DAILY_PROJECT_EXTRA_UDF = {
  total_resource: ["PESOWISE_DPR_TOTAL_RESOURCE", "25065"],
  food: ["PESOWISE_DPR_FOOD", "25066"],
  overtime: ["PESOWISE_DPR_OVERTIME", "25067"],
  other_remarks: ["PESOWISE_DPR_OTHER_REMARKS", "25068"],
  site_code: ["PESOWISE_DPR_SITE_CODE", "25069"],
} as const;
export const DETAILED_EXPENSE_AMOUNT_UDF: readonly [string, string] = ["PESOWISE_DE_AMOUNT", "25070"];
export const DAILY_PROJECT_TOTAL_UDF: readonly [string, string] = ["PESOWISE_DPR_TOTAL_EXPENSE", "25071"];

function value(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return v == null ? "" : String(v).replace(/\|/g, " ").replace(/\r?\n/g, " ").trim();
}

function money(v: unknown): string {
  const normalized = typeof v === "string" ? v.replace(/[₹,\s]/g, "") : v;
  const n = Number(normalized ?? 0);
  return Number.isFinite(n) && n !== 0 ? n.toFixed(2) : "";
}

function fieldsToUdks(
  map: Record<string, readonly [string, string]>,
  values: Record<string, string>,
): LedgerDisplayUdf[] {
  return Object.entries(map).map(([key, [name, index]]) => ({ name, index, value: values[key] ?? "" }));
}

export function buildClaimReportDisplayUdks(
  row: Record<string, unknown>,
  reportType: "claim_verification" | "claim_approval",
): LedgerDisplayUdf[] {
  const status = value(row, "status");
  return fieldsToUdks(CLAIM_REPORT_UDF, {
    employee: value(row, "user_name"),
    employee_id: value(row, "employee_id"),
    email: value(row, "user_email"),
    transaction: value(row, "transaction_number"),
    title: value(row, "title"),
    purpose: value(row, "purpose"),
    destination: value(row, "destination"),
    batch: value(row, "batch_ref"),
    category: value(row, "category") || "-",
    trip_start: formatTrackDateForTally(value(row, "trip_start")),
    trip_end: formatTrackDateForTally(value(row, "trip_end")),
    amount: money(row.total_amount),
    status,
    manager_approval: managerApprovalLabel(reportType, status),
    ho_approval: hoApprovalLabel(reportType),
    submitted_on: formatTrackDateForTally(value(row, "created_at")),
    opening_balance: money(row.opening_balance),
    closing_balance: money(row.closing_balance),
    lpo_number: value(row, "lpo_number") || "-",
  });
}

export function buildDetailedExpenseDisplayUdks(row: Record<string, unknown>): LedgerDisplayUdf[] {
  const credit = Number(typeof row.credit === "string" ? row.credit.replace(/[₹,\s]/g, "") : row.credit ?? 0);
  const debit = Number(typeof row.debit === "string" ? row.debit.replace(/[₹,\s]/g, "") : row.debit ?? 0);
  const custom = row.custom_fields && typeof row.custom_fields === "object"
    ? row.custom_fields as Record<string, unknown>
    : {};
  return [
    ...fieldsToUdks(DETAILED_EXPENSE_UDF, {
    employee: value(row, "employee_name"),
    employee_code: value(row, "employee_code"),
    date: formatTrackDateForTally(value(row, "effective_date") || value(row, "trip_start")),
    transaction: value(row, "transaction_number"),
    title: value(row, "title"),
    event: value(row, "event_label") || value(row, "event_type"),
    category: value(row, "category"),
    purpose: value(row, "purpose"),
    destination: value(row, "destination"),
    batch: value(row, "batch_ref"),
    from_location: value(custom, "From location"),
    project_id: value(custom, "Project ID"),
    project_name: value(custom, "Project Name"),
    project_unique_id: value(custom, "Project Unique ID"),
    to_location: value(custom, "To location"),
    credit: money(row.credit),
    debit: money(row.debit),
    note: value(row, "note"),
    opening_balance: money(row.opening_balance),
    closing_balance: money(row.closing_balance),
    }),
    { name: DETAILED_EXPENSE_AMOUNT_UDF[0], index: DETAILED_EXPENSE_AMOUNT_UDF[1], value: money(debit > 0 ? debit : credit) },
  ];
}

export function buildDailyProjectExtraUdks(
  row: Record<string, unknown>,
  costValues: Record<string, unknown> = (row.costs as Record<string, unknown> | undefined) ?? {},
): LedgerDisplayUdf[] {
  const pick = (...keys: string[]) => {
    for (const key of keys) if (row[key] != null) return value(row, key);
    return "";
  };
  const costs = ["petrol_cost", "material_cost", "travelling_cost", "phone_exp", "hotel_exp", "transport_exp", "contra_bill", "other_exp"]
    .map((key) => Number(costValues[key] ?? row[key] ?? 0))
    .filter(Number.isFinite);
  return [
    ["total_resource", "Total Resource"], ["food", "Food"], ["overtime", "Over Time"],
    ["other_remarks", "Other Remarks"], ["site_code", "Site Id/RO Code"],
  ].map(([key, header]) => {
    const [name, index] = DAILY_PROJECT_EXTRA_UDF[key as keyof typeof DAILY_PROJECT_EXTRA_UDF];
    return { name, index, value: pick(header, key, key.toUpperCase()) };
  }).concat([{ name: DAILY_PROJECT_TOTAL_UDF[0], index: DAILY_PROJECT_TOTAL_UDF[1], value: money(costs.reduce((a, b) => a + b, 0)) }]);
}
