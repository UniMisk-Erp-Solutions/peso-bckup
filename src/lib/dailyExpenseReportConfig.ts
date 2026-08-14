import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_BASE_FIELD_CONFIG,
  type BaseExpenseFieldKey,
} from "@/lib/expenseFormConfig";

export type DailyReportCostColumnKey =
  | "petrol_cost"
  | "material_cost"
  | "travelling_cost"
  | "phone_exp"
  | "hotel_exp"
  | "transport_exp"
  | "contra_bill"
  | "other_exp";

/** Encoded as `base:{field_key}` or `template:{uuid}`. */
export type DailyReportFieldSourceId = string;

export type DailyExpenseReportFieldMappings = {
  projectId: DailyReportFieldSourceId | null;
  projectName: DailyReportFieldSourceId | null;
  location: DailyReportFieldSourceId | null;
};

export type DailyExpenseReportCategoryMappings = Record<DailyReportCostColumnKey, string[]>;

export type DailyExpenseReportConfig = {
  fieldMappings: DailyExpenseReportFieldMappings;
  categoryMappings: DailyExpenseReportCategoryMappings;
};

/** All built-in expense form fields (shown under "Default expense fields" in mapping UI). */
export const DAILY_REPORT_BASE_FIELD_KEYS: BaseExpenseFieldKey[] = [
  "category",
  "title",
  "destination",
  "expense_date",
  "purpose",
  "amount",
];

export const DAILY_REPORT_COST_COLUMNS: { key: DailyReportCostColumnKey; label: string }[] = [
  { key: "petrol_cost", label: "Petrol Cost" },
  { key: "material_cost", label: "Material Cost" },
  { key: "travelling_cost", label: "Travelling Cost" },
  { key: "phone_exp", label: "Phone Exp." },
  { key: "hotel_exp", label: "Hotel Exp." },
  { key: "transport_exp", label: "Transport Exp" },
  { key: "contra_bill", label: "Contra Bill" },
  { key: "other_exp", label: "Other Exp." },
];

export const DAILY_PROJECT_REPORT_HEADERS = [
  "Track Date",
  "Voucher No",
  "project id",
  "project name",
  "Employee",
  "Employee Code",
  "Location",
  "Total Resource",
  "Food",
  "Over Time",
  "Presence",
  "Remarks",
  "Other Remarks",
  "Petrol Cost",
  "Material Cost",
  "Travelling Cost",
  "Phone Exp.",
  "Hotel Exp.",
  "Transport Exp",
  "Contra Bill",
  "Other Exp.",
  "Site Id/RO Code",
  "percent",
] as const;

export type DailyProjectReportHeader = (typeof DAILY_PROJECT_REPORT_HEADERS)[number];

export type DailyProjectExpenseReportRow = Record<DailyProjectReportHeader, string | number>;

export type ParsedFieldSource =
  | { kind: "base"; key: BaseExpenseFieldKey }
  | { kind: "template"; templateId: string }
  | { kind: "branch"; branchId: string };

export type DailyReportFieldValueLookup = {
  templates: Record<string, string>;
  branches: Record<string, string>;
};

export function emptyDailyReportFieldValueLookup(): DailyReportFieldValueLookup {
  return { templates: {}, branches: {} };
}

export function encodeBaseFieldSource(key: BaseExpenseFieldKey): DailyReportFieldSourceId {
  return `base:${key}`;
}

export function encodeTemplateSource(templateId: string): DailyReportFieldSourceId {
  return `template:${templateId}`;
}

export function encodeBranchSource(branchId: string): DailyReportFieldSourceId {
  return `branch:${branchId}`;
}

export function parseFieldSource(raw: string | null | undefined): ParsedFieldSource | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value.startsWith("base:")) {
    const key = value.slice(5) as BaseExpenseFieldKey;
    if (key in DEFAULT_BASE_FIELD_CONFIG) return { kind: "base", key };
    return null;
  }
  if (value.startsWith("branch:")) {
    const branchId = value.slice(7).trim();
    return branchId ? { kind: "branch", branchId } : null;
  }
  if (value.startsWith("template:")) {
    const templateId = value.slice(9).trim();
    return templateId ? { kind: "template", templateId } : null;
  }
  // Legacy: bare template UUID
  return { kind: "template", templateId: value };
}

export function isDailyReportRowNeedsReview(row: DailyProjectExpenseReportRow): boolean {
  return !String(row["project id"] ?? "").trim() || !String(row["project name"] ?? "").trim();
}

export function emptyDailyExpenseReportConfig(): DailyExpenseReportConfig {
  return {
    fieldMappings: {
      projectId: null,
      projectName: null,
      location: null,
    },
    categoryMappings: {
      petrol_cost: [],
      material_cost: [],
      travelling_cost: [],
      phone_exp: [],
      hotel_exp: [],
      transport_exp: [],
      contra_bill: [],
      other_exp: [],
    },
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

function parseFieldMappingValue(
  raw: unknown,
  legacyKey?: unknown,
): DailyReportFieldSourceId | null {
  if (raw != null && String(raw).trim()) {
    return parseFieldSource(String(raw)) ? String(raw).trim() : encodeTemplateSource(String(raw));
  }
  if (legacyKey != null && String(legacyKey).trim()) {
    return encodeTemplateSource(String(legacyKey));
  }
  return null;
}

export function parseDailyExpenseReportConfig(raw: unknown): DailyExpenseReportConfig {
  const base = emptyDailyExpenseReportConfig();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const fieldMappings =
    obj.fieldMappings && typeof obj.fieldMappings === "object"
      ? (obj.fieldMappings as Record<string, unknown>)
      : {};
  const categoryMappings =
    obj.categoryMappings && typeof obj.categoryMappings === "object"
      ? (obj.categoryMappings as Record<string, unknown>)
      : {};

  return {
    fieldMappings: {
      projectId: parseFieldMappingValue(
        fieldMappings.projectId,
        fieldMappings.projectIdTemplateId,
      ),
      projectName: parseFieldMappingValue(
        fieldMappings.projectName,
        fieldMappings.projectNameTemplateId,
      ),
      location: parseFieldMappingValue(
        fieldMappings.location,
        fieldMappings.locationTemplateId,
      ),
    },
    categoryMappings: {
      petrol_cost: asStringArray(categoryMappings.petrol_cost),
      material_cost: asStringArray(categoryMappings.material_cost),
      travelling_cost: asStringArray(categoryMappings.travelling_cost),
      phone_exp: asStringArray(categoryMappings.phone_exp),
      hotel_exp: asStringArray(categoryMappings.hotel_exp),
      transport_exp: asStringArray(categoryMappings.transport_exp),
      contra_bill: asStringArray(categoryMappings.contra_bill),
      other_exp: asStringArray(categoryMappings.other_exp),
    },
  };
}

export function validateDailyExpenseReportConfig(config: DailyExpenseReportConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const { fieldMappings, categoryMappings } = config;

  if (!parseFieldSource(fieldMappings.projectId)) {
    errors.push("projectIdRequired");
  }
  if (!parseFieldSource(fieldMappings.projectName)) {
    errors.push("projectNameRequired");
  }
  // Location is optional for generation; column stays empty when unmapped.

  const seen = new Map<string, DailyReportCostColumnKey>();
  for (const { key } of DAILY_REPORT_COST_COLUMNS) {
    for (const category of categoryMappings[key]) {
      const normalized = category.trim().toLowerCase();
      if (!normalized) continue;
      const existing = seen.get(normalized);
      if (existing && existing !== key) {
        errors.push(`duplicateCategory:${category}`);
      } else {
        seen.set(normalized, key);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isDailyReportConfigReady(config: DailyExpenseReportConfig): boolean {
  const { fieldMappings } = config;
  return (
    Boolean(parseFieldSource(fieldMappings.projectId)) &&
    Boolean(parseFieldSource(fieldMappings.projectName))
  );
}

export function resolveCategoryToCostColumn(
  category: string | null | undefined,
  config: DailyExpenseReportConfig,
): DailyReportCostColumnKey {
  const name = String(category ?? "").trim();
  if (!name) return "other_exp";
  const lower = name.toLowerCase();
  for (const { key } of DAILY_REPORT_COST_COLUMNS) {
    const list = config.categoryMappings[key];
    if (list.some((c) => c.trim().toLowerCase() === lower)) return key;
  }
  return "other_exp";
}

const CATEGORY_AUTO_HINTS: Record<DailyReportCostColumnKey, RegExp[]> = {
  petrol_cost: [/petrol/i, /\bfuel\b/i],
  material_cost: [/material/i],
  travelling_cost: [/travel/i, /travelling/i],
  phone_exp: [/mobile/i, /phone/i, /recharge/i],
  hotel_exp: [/hotel/i, /guest/i],
  transport_exp: [/transport/i, /conveyance/i],
  contra_bill: [/contra/i],
  other_exp: [/other/i, /xerox/i, /stationery/i, /food/i, /manpower/i, /laptop/i],
};

type TemplateOption = { id: string; name: string; field_key: string | null };

export function suggestDefaultFieldMappings(
  templates: TemplateOption[],
): DailyExpenseReportFieldMappings {
  const findTemplate = (patterns: RegExp[]) => {
    for (const tpl of templates) {
      const hay = `${tpl.name} ${tpl.field_key ?? ""}`.toLowerCase();
      if (patterns.some((p) => p.test(hay))) return encodeTemplateSource(tpl.id);
    }
    return null;
  };

  return {
    projectId:
      findTemplate([/project\s*id/i, /\bproject\s*code\b/i, /\bjob\s*id\b/i]) ??
      findTemplate([/\bid\b/i, /code/i]),
    projectName:
      findTemplate([/project\s*name/i]) ??
      findTemplate([/\bproject\b/i, /\btitle\b/i]) ??
      encodeBaseFieldSource("title"),
    location:
      findTemplate([/location/i, /site/i, /vendor/i]) ??
      encodeBaseFieldSource("destination"),
  };
}

export function suggestDefaultCategoryMappings(
  categories: string[],
): DailyExpenseReportCategoryMappings {
  const result = emptyDailyExpenseReportConfig().categoryMappings;
  const assigned = new Set<string>();

  for (const { key } of DAILY_REPORT_COST_COLUMNS) {
    if (key === "other_exp") continue;
    for (const cat of categories) {
      const lower = cat.toLowerCase();
      if (assigned.has(lower)) continue;
      const hints = CATEGORY_AUTO_HINTS[key];
      if (hints.some((h) => h.test(cat))) {
        result[key].push(cat);
        assigned.add(lower);
      }
    }
  }

  for (const cat of categories) {
    if (!assigned.has(cat.toLowerCase())) {
      result.other_exp.push(cat);
    }
  }

  return result;
}

export function isDailyReportSchemaError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? "").toLowerCase();
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    msg.includes("daily_expense_report_config") ||
    msg.includes("schema cache")
  );
}

export async function fetchOrganizationDailyReportConfig(
  organizationId: string,
): Promise<{ config: DailyExpenseReportConfig; needsMigration?: boolean }> {
  if (!organizationId) return { config: emptyDailyExpenseReportConfig() };

  const { data, error } = await supabase
    .from("organization_settings")
    .select("daily_expense_report_config")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    if (isDailyReportSchemaError(error)) {
      return { config: emptyDailyExpenseReportConfig(), needsMigration: true };
    }
    console.warn("fetchOrganizationDailyReportConfig", error);
    return { config: emptyDailyExpenseReportConfig() };
  }

  return { config: parseDailyExpenseReportConfig(data?.daily_expense_report_config) };
}

export async function saveOrganizationDailyReportConfig(
  organizationId: string,
  config: DailyExpenseReportConfig,
): Promise<{ ok: boolean; error?: string; needsMigration?: boolean }> {
  const payload = { daily_expense_report_config: config };

  const { data: existing, error: readError } = await supabase
    .from("organization_settings")
    .select("organization_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (readError && !isDailyReportSchemaError(readError)) {
    return { ok: false, error: readError.message };
  }

  const { error } = existing
    ? await supabase
        .from("organization_settings")
        .update(payload)
        .eq("organization_id", organizationId)
    : await supabase.from("organization_settings").insert({
        organization_id: organizationId,
        ...payload,
      });

  if (error) {
    if (isDailyReportSchemaError(error)) {
      return {
        ok: false,
        needsMigration: true,
        error:
          "Database column daily_expense_report_config is missing. Run supabase/migrations/20260529140000_daily_project_expense_report.sql in Supabase SQL Editor, then reload the API schema.",
      };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export function dailyReportRowToExportRecord(
  row: DailyProjectExpenseReportRow,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const header of DAILY_PROJECT_REPORT_HEADERS) {
    out[header] = row[header] ?? "";
  }
  return out;
}

export function resolveMappedFieldValue(
  sourceId: DailyReportFieldSourceId | null | undefined,
  expense: {
    title?: string | null;
    destination?: string | null;
    purpose?: string | null;
    category?: string | null;
    trip_start?: string | null;
    total_amount?: number | null;
  },
  fieldValues: DailyReportFieldValueLookup | Record<string, string>,
): string {
  const parsed = parseFieldSource(sourceId);
  if (!parsed) return "";
  if (parsed.kind === "base") {
    switch (parsed.key) {
      case "title":
        return String(expense.title ?? "").trim();
      case "destination":
        return String(expense.destination ?? "").trim();
      case "purpose":
        return String(expense.purpose ?? "").trim();
      case "category":
        return String(expense.category ?? "").trim();
      case "expense_date":
        return String(expense.trip_start ?? "").slice(0, 10);
      case "amount":
        return expense.total_amount != null ? String(expense.total_amount) : "";
      default:
        return "";
    }
  }
  const lookup =
    "templates" in fieldValues
      ? fieldValues
      : { templates: fieldValues as Record<string, string>, branches: {} };
  if (parsed.kind === "branch") {
    return String(lookup.branches[parsed.branchId] ?? "").trim();
  }
  return String(lookup.templates[parsed.templateId] ?? "").trim();
}

export function collectMappedFieldSourceIds(config: DailyExpenseReportConfig): {
  templateIds: string[];
  branchIds: string[];
} {
  const templateIds = new Set<string>();
  const branchIds = new Set<string>();
  for (const sourceId of Object.values(config.fieldMappings)) {
    const parsed = parseFieldSource(sourceId);
    if (parsed?.kind === "template") templateIds.add(parsed.templateId);
    if (parsed?.kind === "branch") branchIds.add(parsed.branchId);
  }
  return { templateIds: [...templateIds], branchIds: [...branchIds] };
}
