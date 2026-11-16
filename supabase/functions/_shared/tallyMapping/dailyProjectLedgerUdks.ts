import type { PesowiseTallyMetadataV1 } from "./metadataSchema.ts";
import { buildCommonMetaDisplayUdks } from "./metaDisplayUdks.ts";

/** Ledger UDF slots for TDL Daily Project Report (TallyPrime bootstrap must declare these). */
export const PESOWISE_REPORT_TYPE_UDF_INDEX = "25002";
export const PESOWISE_META_REVISION_UDF_INDEX = "25003";

export const PESOWISE_DPR_UDF = {
  track_date: "25010",
  voucher_no: "25011",
  project_id: "25012",
  project_name: "25013",
  employee: "25014",
  employee_code: "25015",
  location: "25016",
  remarks: "25017",
  petrol_cost: "25018",
  material_cost: "25019",
  travelling_cost: "25020",
  phone_exp: "25021",
  hotel_exp: "25022",
  transport_exp: "25023",
  contra_bill: "25024",
  other_exp: "25025",
  percent: "25026",
  presence: "25027",
} as const;

export const PESOWISE_META_JSON_PLAIN_UDF_INDEX = "25029";

export const DAILY_PROJECT_REPORT_HEADERS = [
  "Track Date", "Voucher No", "project id", "project name", "Employee", "Employee Code", "Location",
  "Total Resource", "Food", "Over Time", "Presence", "Remarks", "Other Remarks", "Petrol Cost",
  "Material Cost", "Travelling Cost", "Phone Exp.", "Hotel Exp.", "Transport Exp", "Contra Bill",
  "Other Exp.", "Site Id/RO Code", "percent",
] as const;

export type LedgerDisplayUdf = {
  name: string;
  index: string;
  value: string;
};

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function formatTrackDateForTally(iso: unknown): string {
  const raw = String(iso ?? "").trim();
  const d = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return raw;
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}

type DailyReportCostColumnKey =
  | "petrol_cost"
  | "material_cost"
  | "travelling_cost"
  | "phone_exp"
  | "hotel_exp"
  | "transport_exp"
  | "contra_bill"
  | "other_exp";

function costAmount(costs: Record<string, unknown> | undefined, key: DailyReportCostColumnKey): string {
  const raw = costs?.[key];
  if (raw == null || raw === "") return "";
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : str(raw);
}

function payrollPercentFromRow(row: Record<string, unknown>, meta: PesowiseTallyMetadataV1): string {
  const direct = row.percent ?? meta.fields.percent;
  if (direct != null && direct !== "") return String(direct);
  const n = Number(row.projects_in_employee_day ?? meta.fields.projects_in_employee_day);
  if (!Number.isFinite(n) || n < 1) return "";
  return String(Math.round((100 / n) * 100) / 100);
}

function resolveRemarks(row: Record<string, unknown>, meta: PesowiseTallyMetadataV1): string {
  const direct = str(row.remarks ?? meta.fields.remarks);
  if (direct) return direct;
  const src = (row.source_expenses ?? meta.fields.source_expenses) as unknown;
  if (!Array.isArray(src)) return "";
  return src
    .map((e) => str((e as Record<string, unknown>).purpose))
    .filter(Boolean)
    .join(", ");
}

function pipeSafe(v: string): string {
  const value = v.replace(/\|/g, " ").replace(/\r?\n/g, " ").trim();
  if (!value) return "__PW_EMPTY__";
  return value === "__PW_EMPTY__" ? "__PW_EMPTY____PW_EMPTY__" : value;
}

function reportCell(row: Record<string, unknown>, header: string): string {
  if (row[header] != null) return str(row[header]);
  const aliases: Record<string, unknown> = {
    "Track Date": row.track_date, "Voucher No": row.voucher_no, "project id": row.project_id,
    "project name": row.project_name, Employee: row.employee_name, "Employee Code": row.employee_code,
    Location: row.location, Presence: row.presence, Remarks: row.remarks, percent: row.percent,
  };
  return str(aliases[header]);
}

export function buildDailyProjectFlatRow(
  meta: PesowiseTallyMetadataV1,
  row: Record<string, unknown>,
): string {
  const costs = (row.costs ?? meta.fields.costs ?? {}) as Record<string, unknown>;
  const costByHeader: Record<string, DailyReportCostColumnKey> = {
    "Petrol Cost": "petrol_cost", "Material Cost": "material_cost", "Travelling Cost": "travelling_cost",
    "Phone Exp.": "phone_exp", "Hotel Exp.": "hotel_exp", "Transport Exp": "transport_exp",
    "Contra Bill": "contra_bill", "Other Exp.": "other_exp",
  };
  const trackIso = str(meta.fields.track_date ?? reportCell(row, "Track Date"));
  return DAILY_PROJECT_REPORT_HEADERS.map((header) => {
    if (header === "Track Date") return pipeSafe(formatTrackDateForTally(trackIso));
    if (header === "project id") return pipeSafe(str(meta.project_id ?? reportCell(row, header)));
    if (header === "Remarks") return pipeSafe(resolveRemarks(row, meta));
    if (header in costByHeader) return pipeSafe(costAmount(costs, costByHeader[header]) || reportCell(row, header));
    if (header === "percent") return pipeSafe(payrollPercentFromRow(row, meta));
    return pipeSafe(reportCell(row, header));
  }).join("|");
}

/** Flat ledger UDFs so TDL can render Daily Project columns without JSON parsing. */
export function buildDailyProjectLedgerUdks(
  meta: PesowiseTallyMetadataV1,
  row: Record<string, unknown>,
  syncRunId?: string,
): LedgerDisplayUdf[] {
  const costs = (row.costs ?? meta.fields.costs ?? {}) as Record<string, unknown>;
  const trackIso = str(meta.fields.track_date ?? row.track_date ?? "");
  const projectId = str(meta.project_id ?? row.project_id ?? "");
  const flatRow = buildDailyProjectFlatRow(meta, row);

  return [
    ...buildCommonMetaDisplayUdks(meta, flatRow, syncRunId),
    { name: "PESOWISE_DPR_TRACK_DATE", index: PESOWISE_DPR_UDF.track_date, value: formatTrackDateForTally(trackIso) },
    { name: "PESOWISE_DPR_VOUCHER_NO", index: PESOWISE_DPR_UDF.voucher_no, value: str(row.voucher_no) },
    { name: "PESOWISE_DPR_PROJECT_ID", index: PESOWISE_DPR_UDF.project_id, value: projectId },
    { name: "PESOWISE_DPR_PROJECT_NAME", index: PESOWISE_DPR_UDF.project_name, value: str(row.project_name) },
    { name: "PESOWISE_DPR_EMPLOYEE", index: PESOWISE_DPR_UDF.employee, value: str(row.employee_name) },
    { name: "PESOWISE_DPR_EMPLOYEE_CODE", index: PESOWISE_DPR_UDF.employee_code, value: str(row.employee_code) },
    { name: "PESOWISE_DPR_LOCATION", index: PESOWISE_DPR_UDF.location, value: str(row.location) },
    { name: "PESOWISE_DPR_REMARKS", index: PESOWISE_DPR_UDF.remarks, value: resolveRemarks(row, meta) },
    { name: "PESOWISE_DPR_PETROL_COST", index: PESOWISE_DPR_UDF.petrol_cost, value: costAmount(costs, "petrol_cost") },
    { name: "PESOWISE_DPR_MATERIAL_COST", index: PESOWISE_DPR_UDF.material_cost, value: costAmount(costs, "material_cost") },
    { name: "PESOWISE_DPR_TRAVELLING_COST", index: PESOWISE_DPR_UDF.travelling_cost, value: costAmount(costs, "travelling_cost") },
    { name: "PESOWISE_DPR_PHONE_EXP", index: PESOWISE_DPR_UDF.phone_exp, value: costAmount(costs, "phone_exp") },
    { name: "PESOWISE_DPR_HOTEL_EXP", index: PESOWISE_DPR_UDF.hotel_exp, value: costAmount(costs, "hotel_exp") },
    { name: "PESOWISE_DPR_TRANSPORT_EXP", index: PESOWISE_DPR_UDF.transport_exp, value: costAmount(costs, "transport_exp") },
    { name: "PESOWISE_DPR_CONTRA_BILL", index: PESOWISE_DPR_UDF.contra_bill, value: costAmount(costs, "contra_bill") },
    { name: "PESOWISE_DPR_OTHER_EXP", index: PESOWISE_DPR_UDF.other_exp, value: costAmount(costs, "other_exp") },
    { name: "PESOWISE_DPR_PERCENT", index: PESOWISE_DPR_UDF.percent, value: payrollPercentFromRow(row, meta) },
    { name: "PESOWISE_DPR_PRESENCE", index: PESOWISE_DPR_UDF.presence, value: "P" },
  ];
}
