import { supabase } from "@/integrations/supabase/client";
import {
  fetchExpenseSubmitterProfiles,
  chunkArray,
  SUPABASE_IN_QUERY_CHUNK_SIZE,
} from "@/lib/supabaseInQuery";
import {
  DAILY_PROJECT_REPORT_HEADERS,
  collectMappedFieldSourceIds,
  emptyDailyReportFieldValueLookup,
  resolveMappedFieldValue,
  type DailyExpenseReportConfig,
  type DailyProjectExpenseReportRow,
  type DailyReportCostColumnKey,
  type DailyReportFieldValueLookup,
  resolveCategoryToCostColumn,
} from "@/lib/dailyExpenseReportConfig";

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type RawDailyReportExpense = {
  id: string;
  user_id: string;
  trip_start: string | null;
  category: string | null;
  total_amount: number | null;
  title?: string | null;
  destination?: string | null;
  purpose?: string | null;
  transaction_number?: string | null;
};

export type DailyReportEmployeeProfile = {
  user_id: string;
  name: string;
  employee_id: string | null;
};

export function formatTrackDate(tripStart: string | null): string {
  if (!tripStart) return "";
  const d = tripStart.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}

function groupKey(trackDate: string, userId: string, projectId: string): string {
  return [trackDate, userId, projectId].join("\u001f");
}

function mergeTextField(current: string, incoming: string): string {
  const next = String(incoming ?? "").trim();
  if (!next) return current;
  if (!String(current ?? "").trim()) return next;
  return current;
}

function employeeDayKey(trackDate: string, userId: string): string {
  return `${trackDate}\u001f${userId}`;
}

/** 100 ÷ distinct project rows that employee has on that day (payroll allocation split). */
export function payrollPercentForEmployeeDay(projectCount: number): number {
  const count = Math.max(1, projectCount);
  return Math.round((100 / count) * 100) / 100;
}

function emptyCostBuckets(): Record<DailyReportCostColumnKey, number> {
  return {
    petrol_cost: 0,
    material_cost: 0,
    travelling_cost: 0,
    phone_exp: 0,
    hotel_exp: 0,
    transport_exp: 0,
    contra_bill: 0,
    other_exp: 0,
  };
}

export function costColumnToHeader(key: DailyReportCostColumnKey): keyof DailyProjectExpenseReportRow {
  const map: Record<DailyReportCostColumnKey, keyof DailyProjectExpenseReportRow> = {
    petrol_cost: "Petrol Cost",
    material_cost: "Material Cost",
    travelling_cost: "Travelling Cost",
    phone_exp: "Phone Exp.",
    hotel_exp: "Hotel Exp.",
    transport_exp: "Transport Exp",
    contra_bill: "Contra Bill",
    other_exp: "Other Exp.",
  };
  return map[key];
}

function resolveVoucherNo(exp: RawDailyReportExpense): string {
  const txn = String(exp.transaction_number ?? "").trim();
  if (txn) return txn;
  return String(exp.title ?? "").trim();
}

export type DailyReportSourceExpense = {
  id: string;
  category: string | null;
  total_amount: number;
  trip_start: string | null;
  title: string | null;
  transaction_number: string | null;
  voucherNo: string;
  costColumn: DailyReportCostColumnKey;
  costColumnLabel: string;
  projectId: string;
  projectName: string;
  location: string;
  /** Base `purpose` column -- shown as "Remark" in Batch Review after this
   * org's own field relabeling. Comma-joined across every expense in a
   * grouped report row to populate the "Remarks" export column. */
  purpose: string | null;
};

export type DailyProjectExpenseReportBuildResult = {
  row: DailyProjectExpenseReportRow;
  sourceExpenses: DailyReportSourceExpense[];
};

export function dailyReportResultsToRows(
  results: DailyProjectExpenseReportBuildResult[],
): DailyProjectExpenseReportRow[] {
  return results.map((result) => result.row);
}

/**
 * One logical Daily Project Report row before final shaping.
 *
 * A report row is NOT an expense: it is the (trackDate, userId, projectId)
 * grouping. Both the legacy all-in-browser pipeline and the server-paged
 * pipeline (DOC-101) produce this shape and hand it to
 * `finalizeDailyReportGroups`, so the two cannot drift in row ordering,
 * `percent`, or any cell value.
 */
export type DailyReportGroup = {
  /** Already formatted DD-MM-YYYY, or "" when the expense has no usable date. */
  trackDate: string;
  userId: string;
  projectId: string;
  projectName: string;
  location: string;
  voucherNo: string;
  employeeName: string;
  employeeCode: string;
  costs: Record<DailyReportCostColumnKey, number>;
  sourceExpenses: DailyReportSourceExpense[];
};

/**
 * Sort the COMPLETE set of report groups and shape each into a workbook row.
 *
 * `percent` is derived here from the full set, because
 * payrollPercentForEmployeeDay splits 100 across every project row an employee
 * has on that day. Handing this a partial set silently produces wrong
 * percentages — which is exactly why the server-paged export coordinator
 * refuses to build a workbook until it has proven it holds every row.
 */
export function finalizeDailyReportGroups(
  groups: DailyReportGroup[],
): DailyProjectExpenseReportBuildResult[] {
  const projectsPerEmployeeDay = new Map<string, number>();
  for (const group of groups) {
    const dayKey = employeeDayKey(group.trackDate, group.userId);
    projectsPerEmployeeDay.set(dayKey, (projectsPerEmployeeDay.get(dayKey) ?? 0) + 1);
  }

  return [...groups]
    .sort((a, b) => {
      const dateCmp = a.trackDate.localeCompare(b.trackDate);
      if (dateCmp !== 0) return dateCmp;
      const nameCmp = a.employeeName.localeCompare(b.employeeName);
      if (nameCmp !== 0) return nameCmp;
      const projCmp = a.projectId.localeCompare(b.projectId);
      if (projCmp !== 0) return projCmp;
      return a.projectName.localeCompare(b.projectName);
    })
    .map((g) => {
      const sortedSourceExpenses = [...g.sourceExpenses].sort((a, b) => {
        const dateCmp = String(a.trip_start ?? "").localeCompare(String(b.trip_start ?? ""));
        if (dateCmp !== 0) return dateCmp;
        return String(a.category ?? "").localeCompare(String(b.category ?? ""));
      });

      // A report row groups every expense sharing (trackDate, employee,
      // project) -- e.g. every line of one multi-line batch. Each line's
      // own free-text remark (base `purpose`, shown as "Remark" after this
      // org's own field relabeling -- see expenseFormConfig.ts) is joined
      // here in the group's own natural order, one comma-separated string
      // per line, duplicates and all -- this is real per-line data, not
      // deduplicated or reordered.
      const remarks = sortedSourceExpenses
        .map((src) => String(src.purpose ?? "").trim())
        .filter((p) => p !== "")
        .join(", ");

      const row = {} as DailyProjectExpenseReportRow;
      for (const header of DAILY_PROJECT_REPORT_HEADERS) {
        row[header] = "";
      }
      row["Track Date"] = g.trackDate;
      row["Voucher No"] = g.voucherNo;
      row["project id"] = g.projectId;
      row["project name"] = g.projectName;
      row["Employee"] = g.employeeName;
      row["Employee Code"] = g.employeeCode;
      row["Location"] = g.location;
      row["Presence"] = "P";
      row["Remarks"] = remarks;
      row["percent"] = payrollPercentForEmployeeDay(
        projectsPerEmployeeDay.get(employeeDayKey(g.trackDate, g.userId)) ?? 1,
      );

      for (const colKey of Object.keys(g.costs) as DailyReportCostColumnKey[]) {
        const amount = g.costs[colKey];
        if (amount > 0) {
          row[costColumnToHeader(colKey)] = amount;
        }
      }

      return { row, sourceExpenses: sortedSourceExpenses };
    });
}

export function buildDailyProjectExpenseReportRows(input: {
  expenses: RawDailyReportExpense[];
  profilesByUserId: Record<string, DailyReportEmployeeProfile>;
  fieldValuesByExpenseId: Record<
    string,
    { projectId: string; projectName: string; location: string }
  >;
  config: DailyExpenseReportConfig;
}): DailyProjectExpenseReportBuildResult[] {
  const { expenses, profilesByUserId, fieldValuesByExpenseId } = input;

  const groups = new Map<string, DailyReportGroup>();

  for (const exp of expenses) {
    const trackDate = formatTrackDate(exp.trip_start);
    const fields = fieldValuesByExpenseId[exp.id] ?? {
      projectId: "",
      projectName: "",
      location: "",
    };
    const normalizedProjectId = String(fields.projectId ?? "").trim();
    const key = groupKey(trackDate, exp.user_id, normalizedProjectId);

    let group = groups.get(key);
    if (!group) {
      group = {
        trackDate,
        userId: exp.user_id,
        projectId: normalizedProjectId,
        projectName: String(fields.projectName ?? "").trim(),
        location: String(fields.location ?? "").trim(),
        voucherNo: resolveVoucherNo(exp),
        employeeName: profilesByUserId[exp.user_id]?.name ?? "",
        employeeCode: profilesByUserId[exp.user_id]?.employee_id ?? "",
        costs: emptyCostBuckets(),
        sourceExpenses: [],
      };
      groups.set(key, group);
    } else {
      group.projectName = mergeTextField(group.projectName, fields.projectName);
      group.location = mergeTextField(group.location, fields.location);
      if (!group.voucherNo) {
        group.voucherNo = resolveVoucherNo(exp);
      }
    }

    const column = resolveCategoryToCostColumn(exp.category, input.config);
    group.costs[column] += Number(exp.total_amount || 0);
    group.sourceExpenses.push({
      id: exp.id,
      category: exp.category ?? null,
      total_amount: Number(exp.total_amount || 0),
      trip_start: exp.trip_start ?? null,
      title: exp.title ?? null,
      transaction_number: exp.transaction_number ?? null,
      voucherNo: resolveVoucherNo(exp),
      costColumn: column,
      costColumnLabel: String(costColumnToHeader(column)),
      projectId: normalizedProjectId,
      projectName: String(fields.projectName ?? "").trim(),
      location: String(fields.location ?? "").trim(),
      purpose: exp.purpose ?? null,
    });
  }

  return finalizeDailyReportGroups([...groups.values()]);
}

async function fetchFieldValuesForMappings(
  organizationId: string,
  expenseIds: string[],
  templateIds: string[],
  branchIds: string[],
): Promise<Record<string, DailyReportFieldValueLookup>> {
  const result: Record<string, DailyReportFieldValueLookup> = {};
  const templateIdSet = new Set(templateIds.filter(Boolean));
  const branchIdSet = new Set(branchIds.filter(Boolean));
  if (expenseIds.length === 0 || (templateIdSet.size === 0 && branchIdSet.size === 0)) {
    return result;
  }

  for (const batch of chunkIds(expenseIds, 75)) {
    const withOrg = await supabase
      .from("expense_form_field_values")
      .select("expense_id, template_id, branch_field_id, field_value")
      .in("expense_id", batch)
      .eq("organization_id", organizationId);

    let rows = withOrg.error ? null : withOrg.data;
    if (withOrg.error) {
      const fallback = await supabase
        .from("expense_form_field_values")
        .select("expense_id, template_id, branch_field_id, field_value")
        .in("expense_id", batch);
      if (fallback.error) {
        console.warn("expense_form_field_values (daily report)", fallback.error);
        continue;
      }
      rows = fallback.data;
    }

    for (const row of rows || []) {
      if (!result[row.expense_id]) {
        result[row.expense_id] = emptyDailyReportFieldValueLookup();
      }
      const bucket = result[row.expense_id];
      if (row.template_id && templateIdSet.has(row.template_id)) {
        bucket.templates[row.template_id] = String(row.field_value ?? "");
      }
      if (row.branch_field_id && branchIdSet.has(row.branch_field_id)) {
        bucket.branches[row.branch_field_id] = String(row.field_value ?? "");
      }
    }
  }

  return result;
}

export async function fetchDailyProjectExpenseReportRows(options: {
  organizationId: string;
  config: DailyExpenseReportConfig;
  dateFrom?: string | null;
  dateTo?: string | null;
  userId?: string | null;
  /** When set (team reports), limit to these submitters. */
  userIds?: string[] | null;
}): Promise<DailyProjectExpenseReportBuildResult[]> {
  const { organizationId, config, dateFrom, dateTo, userId, userIds } = options;

  const baseQuery = () => {
    let query = supabase
      .from("expenses")
      .select(
        "id, user_id, trip_start, category, total_amount, title, destination, purpose, transaction_number",
      )
      .eq("organization_id", organizationId)
      .eq("status", "approved");

    if (dateFrom) query = query.gte("trip_start", dateFrom);
    if (dateTo) query = query.lte("trip_start", dateTo);

    return query;
  };

  let expenses: RawDailyReportExpense[] = [];

  if (userId) {
    const { data, error } = await baseQuery().eq("user_id", userId).order("trip_start", { ascending: true });
    if (error) throw error;
    expenses = (data ?? []) as RawDailyReportExpense[];
  } else if (userIds != null) {
    if (userIds.length === 0) return [];
    for (const batch of chunkArray(userIds, SUPABASE_IN_QUERY_CHUNK_SIZE)) {
      const { data, error } = await baseQuery().in("user_id", batch).order("trip_start", { ascending: true });
      if (error) throw error;
      if (data?.length) expenses.push(...(data as RawDailyReportExpense[]));
    }
    expenses.sort((a, b) => String(a.trip_start ?? "").localeCompare(String(b.trip_start ?? "")));
  } else {
    const { data, error } = await baseQuery().order("trip_start", { ascending: true });
    if (error) throw error;
    expenses = (data ?? []) as RawDailyReportExpense[];
  }

  if (!expenses.length) return [];

  const uniqueUserIds = [...new Set(expenses.map((e) => e.user_id))];
  const submitterProfiles = await fetchExpenseSubmitterProfiles(
    supabase,
    organizationId,
    uniqueUserIds as string[],
  );

  const profilesByUserId: Record<string, DailyReportEmployeeProfile> = {};
  for (const p of submitterProfiles) {
    profilesByUserId[p.user_id] = {
      user_id: p.user_id,
      name: p.name ?? "",
      employee_id: p.employee_id || null,
    };
  }

  const { templateIds, branchIds } = collectMappedFieldSourceIds(config);
  const valuesByExpense = await fetchFieldValuesForMappings(
    organizationId,
    expenses.map((e) => e.id),
    templateIds,
    branchIds,
  );

  const fieldValuesByExpenseId: Record<
    string,
    { projectId: string; projectName: string; location: string }
  > = {};

  const { fieldMappings } = config;

  for (const exp of expenses) {
    const lookup = valuesByExpense[exp.id] ?? emptyDailyReportFieldValueLookup();
    fieldValuesByExpenseId[exp.id] = {
      projectId: resolveMappedFieldValue(fieldMappings.projectId, exp, lookup),
      projectName: resolveMappedFieldValue(fieldMappings.projectName, exp, lookup),
      location: resolveMappedFieldValue(fieldMappings.location, exp, lookup),
    };
  }

  return buildDailyProjectExpenseReportRows({
    expenses,
    profilesByUserId,
    fieldValuesByExpenseId,
    config,
  });
}
