/**
 * Import missing expenses from a JSON export (e.g. cloud backup) into the current org.
 * Supports full org backup format including profiles & memberships for employee linkage.
 */

import { normalizeReceiptPublicUrl } from "@/lib/attachmentPreview";

const UPSERT_BATCH = 80;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any;

export type ExpenseImportPayload = {
  exportedAt?: string;
  organizationId?: string;
  sourceOrganizationId?: string;
  importType?: "expenses-only" | "full-backup";
  expenses: Record<string, unknown>[];
  profiles?: Record<string, unknown>[];
  organization_memberships?: Record<string, unknown>[];
  user_roles?: Record<string, unknown>[];
  expense_line_items?: Record<string, unknown>[];
  attachments?: Record<string, unknown>[];
  expense_form_field_values?: Record<string, unknown>[];
  audit_logs?: Record<string, unknown>[];
};

export type ExpenseImportPreviewRow = {
  expenseId: string;
  title: string;
  tripStart: string;
  amount: number;
  status: string;
  userId: string;
  employeeName: string | null;
  employeeId: string | null;
  email: string | null;
  action: "import" | "skip_existing" | "skip_invalid" | "skip_no_user";
};

export type ExpenseImportPreview = {
  sourceOrganizationId: string | null;
  totalExpenses: number;
  toImport: number;
  skippedExisting: number;
  skippedUnknownUser: number;
  skippedInvalid: number;
  unknownUserIds: string[];
  profilesToImport: number;
  membershipsToImport: number;
  attachments: number;
  lineItems: number;
  formFieldValues: number;
  auditLogs: number;
  dataFrom: string | null;
  dataTo: string | null;
  rows: ExpenseImportPreviewRow[];
};

export type ExpenseImportResult = {
  success: boolean;
  imported: number;
  skippedExisting: number;
  skippedUnknownUser: number;
  skippedInvalid: number;
  profilesImported: number;
  membershipsImported: number;
  lineItemsImported: number;
  attachmentsImported: number;
  formValuesImported: number;
  auditLogsImported: number;
  errors: string[];
};

type EmployeeProfile = {
  user_id: string;
  name: string;
  email: string;
  employee_id: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
}

function normalizeEmployeeId(value: unknown): string | null {
  const s = String(value ?? "").trim().toLowerCase();
  return s || null;
}

function buildProfileMaps(profiles: Record<string, unknown>[]) {
  const byUserId = new Map<string, EmployeeProfile>();
  const byEmployeeId = new Map<string, EmployeeProfile>();

  for (const raw of profiles) {
    const userId = String(raw.user_id ?? "").trim();
    if (!userId) continue;
    const profile: EmployeeProfile = {
      user_id: userId,
      name: String(raw.name ?? "").trim() || "Unknown",
      email: String(raw.email ?? "").trim(),
      employee_id: normalizeEmployeeId(raw.employee_id),
    };
    byUserId.set(userId, profile);
    if (profile.employee_id) byEmployeeId.set(profile.employee_id, profile);
  }

  return { byUserId, byEmployeeId };
}

export function normalizeExpenseImportPayload(raw: unknown): ExpenseImportPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid JSON: expected an object");
  }
  const data = raw as Record<string, unknown>;
  if (!("expenses" in data)) {
    throw new Error("Invalid import file: missing \"expenses\" array");
  }
  const expenses = asRecordArray(data.expenses);
  if (expenses.length === 0) {
    throw new Error("No expenses found in the import file");
  }

  return {
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : undefined,
    organizationId: typeof data.organizationId === "string" ? data.organizationId : undefined,
    sourceOrganizationId:
      typeof data.sourceOrganizationId === "string"
        ? data.sourceOrganizationId
        : typeof data.organizationId === "string"
          ? data.organizationId
          : undefined,
    importType:
      data.importType === "expenses-only" || data.importType === "full-backup"
        ? data.importType
        : data.organizationId
          ? "full-backup"
          : "expenses-only",
    expenses,
    profiles: asRecordArray(data.profiles),
    organization_memberships: asRecordArray(data.organization_memberships),
    user_roles: asRecordArray(data.user_roles),
    expense_line_items: asRecordArray(data.expense_line_items),
    attachments: asRecordArray(data.attachments),
    expense_form_field_values: asRecordArray(data.expense_form_field_values),
    audit_logs: asRecordArray(data.audit_logs),
  };
}

export function parseExpenseImportFile(file: File): Promise<ExpenseImportPayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string) as unknown;
        resolve(normalizeExpenseImportPayload(raw));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file, "utf-8");
  });
}

async function fetchOrgProfiles(
  supabase: SupabaseLike,
  organizationId: string,
): Promise<Map<string, EmployeeProfile>> {
  const map = new Map<string, EmployeeProfile>();
  let offset = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, name, email, employee_id")
      .eq("organization_id", organizationId)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message ?? String(error));
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const r = row as EmployeeProfile;
      if (r.user_id) map.set(r.user_id, r);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return map;
}

async function fetchExistingExpenseIds(
  supabase: SupabaseLike,
  expenseIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const batch of chunk(expenseIds, 100)) {
    const { data, error } = await supabase.from("expenses").select("id").in("id", batch);
    if (error) throw new Error(error.message ?? String(error));
    for (const row of data ?? []) {
      const id = (row as { id?: string }).id;
      if (id) existing.add(id);
    }
  }
  return existing;
}

function expenseDates(expenses: Record<string, unknown>[]): { from: string | null; to: string | null } {
  const dates: string[] = [];
  for (const e of expenses) {
    if (e.trip_start) dates.push(String(e.trip_start).slice(0, 10));
    if (e.trip_end) dates.push(String(e.trip_end).slice(0, 10));
    if (e.created_at) dates.push(String(e.created_at).slice(0, 10));
  }
  if (dates.length === 0) return { from: null, to: null };
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

/** Resolve submitter user_id from expense row + profile maps (supports employee_id / name hints). */
function resolveExpenseUserId(
  expense: Record<string, unknown>,
  fileByUserId: Map<string, EmployeeProfile>,
  fileByEmployeeId: Map<string, EmployeeProfile>,
  orgProfiles: Map<string, EmployeeProfile>,
): string | null {
  const directUserId = String(expense.user_id ?? "").trim();
  if (directUserId && (orgProfiles.has(directUserId) || fileByUserId.has(directUserId))) {
    return directUserId;
  }

  const empId = normalizeEmployeeId(
    expense.employee_id ?? expense.emp_id ?? expense.employee_code,
  );
  if (empId) {
    const fromFile = fileByEmployeeId.get(empId);
    if (fromFile) return fromFile.user_id;
    for (const p of orgProfiles.values()) {
      if (p.employee_id === empId) return p.user_id;
    }
  }

  const empName = String(expense.employee_name ?? expense.user_name ?? expense.employee ?? "")
    .trim()
    .toLowerCase();
  if (empName) {
    for (const p of fileByUserId.values()) {
      if (p.name.trim().toLowerCase() === empName) return p.user_id;
    }
    for (const p of orgProfiles.values()) {
      if (p.name.trim().toLowerCase() === empName) return p.user_id;
    }
  }

  if (directUserId && fileByUserId.has(directUserId)) return directUserId;

  return directUserId || null;
}

function employeeDisplayForUser(
  userId: string,
  fileByUserId: Map<string, EmployeeProfile>,
  orgProfiles: Map<string, EmployeeProfile>,
): { name: string | null; email: string | null; employee_id: string | null } {
  const p = orgProfiles.get(userId) ?? fileByUserId.get(userId);
  return {
    name: p?.name ?? null,
    email: p?.email ?? null,
    employee_id: p?.employee_id ?? null,
  };
}

function prepareExpenseRow(
  row: Record<string, unknown>,
  organizationId: string,
  userId: string,
): Record<string, unknown> | null {
  const id = String(row.id ?? "").trim();
  const title = String(row.title ?? "").trim();
  const tripStart = String(row.trip_start ?? "").trim();
  const tripEnd = String(row.trip_end ?? row.trip_start ?? "").trim();
  const destination = String(row.destination ?? "").trim();

  if (!id || !title || !tripStart || !destination) return null;

  const cleaned = { ...row };
  delete cleaned.employee_name;
  delete cleaned.user_name;
  delete cleaned.employee;
  delete cleaned.employee_id;
  delete cleaned.emp_id;
  delete cleaned.employee_code;
  delete cleaned.user_email;
  delete cleaned.email;

  return {
    ...cleaned,
    id,
    user_id: userId,
    title,
    trip_start: tripStart,
    trip_end: tripEnd || tripStart,
    destination,
    organization_id: organizationId,
    purpose: row.purpose ?? null,
    category: row.category ?? null,
    status: row.status ?? "submitted",
    total_amount: row.total_amount ?? 0,
    assigned_engineer_id: row.assigned_engineer_id ?? null,
    assigned_reviewer_id: row.assigned_reviewer_id ?? null,
    approval_tier: row.approval_tier ?? null,
    batch_id: row.batch_id ?? null,
    admin_comment: row.admin_comment ?? null,
    transaction_number: row.transaction_number ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };
}

function prepareProfileRow(
  row: Record<string, unknown>,
  organizationId: string,
): Record<string, unknown> | null {
  const userId = String(row.user_id ?? "").trim();
  const name = String(row.name ?? "").trim();
  const email = String(row.email ?? "").trim();
  if (!userId || !name) return null;

  return {
    ...row,
    user_id: userId,
    name,
    email: email || `${userId}@import.local`,
    organization_id: organizationId,
    employee_id: normalizeEmployeeId(row.employee_id) ?? row.employee_id ?? null,
    balance: row.balance ?? 0,
    is_active: row.is_active ?? true,
    is_master_admin: row.is_master_admin ?? false,
    reporting_engineer_id: row.reporting_engineer_id ?? null,
    cashier_assigned_engineer_id: row.cashier_assigned_engineer_id ?? null,
    assigned_cashier_id: row.assigned_cashier_id ?? null,
    cashier_assigned_location_id: row.cashier_assigned_location_id ?? null,
    preferred_language: row.preferred_language ?? "en",
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  };
}

function prepareChildRows(
  rows: Record<string, unknown>[],
  expenseIds: Set<string>,
  organizationId: string,
  rewriteAttachmentUrls: boolean,
): Record<string, unknown>[] {
  return rows
    .filter((r) => expenseIds.has(String(r.expense_id ?? "")))
    .map((r) => {
      const next: Record<string, unknown> = {
        ...r,
        organization_id: organizationId,
      };
      if (rewriteAttachmentUrls && typeof r.file_url === "string" && r.file_url.trim()) {
        next.file_url = normalizeReceiptPublicUrl(r.file_url);
      }
      return next;
    });
}

function collectUserIdsForImport(
  payload: ExpenseImportPayload,
  importableExpenseUserIds: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const uid of importableExpenseUserIds) ids.add(uid);
  return ids;
}

function profilesForUsers(
  payload: ExpenseImportPayload,
  userIds: Set<string>,
  organizationId: string,
  existingOrgUserIds: Set<string>,
): Record<string, unknown>[] {
  const fileProfiles = payload.profiles ?? [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const raw of fileProfiles) {
    const userId = String(raw.user_id ?? "").trim();
    if (!userId || !userIds.has(userId) || seen.has(userId)) continue;
    const prepared = prepareProfileRow(raw, organizationId);
    if (!prepared) continue;
    out.push(prepared);
    seen.add(userId);
  }

  return out;
}

function membershipsForUsers(
  payload: ExpenseImportPayload,
  userIds: Set<string>,
  organizationId: string,
): Record<string, unknown>[] {
  const memberships = payload.organization_memberships ?? [];
  return memberships
    .filter((m) => userIds.has(String(m.user_id ?? "")))
    .map((m) => ({
      ...m,
      organization_id: organizationId,
    }));
}

type ImportPlan = {
  importableIds: Set<string>;
  importableUserIds: Set<string>;
  rows: ExpenseImportPreviewRow[];
  toImport: number;
  skippedExisting: number;
  skippedUnknownUser: number;
  skippedInvalid: number;
  unknownUserIds: string[];
};

function buildImportPlan(
  payload: ExpenseImportPayload,
  organizationId: string,
  existingExpenseIds: Set<string>,
  orgProfiles: Map<string, EmployeeProfile>,
  fileByUserId: Map<string, EmployeeProfile>,
  fileByEmployeeId: Map<string, EmployeeProfile>,
): ImportPlan {
  const importableIds = new Set<string>();
  const importableUserIds = new Set<string>();
  const rows: ExpenseImportPreviewRow[] = [];
  let toImport = 0;
  let skippedExisting = 0;
  let skippedUnknownUser = 0;
  let skippedInvalid = 0;
  const unknownUserIds = new Set<string>();

  for (const e of payload.expenses) {
    const id = String(e.id ?? "");
    const title = String(e.title ?? "Untitled");
    const tripStart = String(e.trip_start ?? "").slice(0, 10);
    const amount = Number(e.total_amount) || 0;
    const expenseStatus = String(e.status ?? "submitted");

    if (!id) {
      skippedInvalid += 1;
      rows.push({
        expenseId: "—",
        title,
        tripStart,
        amount,
        status: expenseStatus,
        userId: "",
        employeeName: null,
        employeeId: null,
        email: null,
        action: "skip_invalid",
      });
      continue;
    }

    if (existingExpenseIds.has(id)) {
      skippedExisting += 1;
      const uid = String(e.user_id ?? "");
      const emp = uid ? employeeDisplayForUser(uid, fileByUserId, orgProfiles) : null;
      rows.push({
        expenseId: id,
        title,
        tripStart,
        amount,
        status: expenseStatus,
        userId: uid,
        employeeName: emp?.name ?? (String(e.employee_name ?? e.user_name ?? "") || null),
        employeeId: emp?.employee_id ?? normalizeEmployeeId(e.employee_id ?? e.emp_id),
        email: emp?.email ?? (String(e.user_email ?? e.email ?? "") || null),
        action: "skip_existing",
      });
      continue;
    }

    const userId = resolveExpenseUserId(e, fileByUserId, fileByEmployeeId, orgProfiles);
    const canImportProfileFromFile = userId && fileByUserId.has(userId);
    const inOrg = userId ? orgProfiles.has(userId) : false;

    if (!userId || (!inOrg && !canImportProfileFromFile)) {
      skippedUnknownUser += 1;
      if (userId) unknownUserIds.add(userId);
      rows.push({
        expenseId: id,
        title,
        tripStart,
        amount,
        status: expenseStatus,
        userId: userId ?? "",
        employeeName: String(e.employee_name ?? e.user_name ?? "") || null,
        employeeId: normalizeEmployeeId(e.employee_id ?? e.emp_id),
        email: String(e.user_email ?? e.email ?? "") || null,
        action: "skip_no_user",
      });
      continue;
    }

    if (!prepareExpenseRow(e, organizationId, userId)) {
      skippedInvalid += 1;
      rows.push({
        expenseId: id,
        title,
        tripStart,
        amount,
        status: expenseStatus,
        userId,
        employeeName: null,
        employeeId: null,
        email: null,
        action: "skip_invalid",
      });
      continue;
    }

    toImport += 1;
    importableIds.add(id);
    importableUserIds.add(userId);
    const emp = employeeDisplayForUser(userId, fileByUserId, orgProfiles);
    rows.push({
      expenseId: id,
      title,
      tripStart,
      amount,
      status: expenseStatus,
      userId,
      employeeName: emp.name ?? (String(e.employee_name ?? e.user_name ?? "") || null),
      employeeId: emp.employee_id ?? normalizeEmployeeId(e.employee_id ?? e.emp_id),
      email: emp.email ?? (String(e.user_email ?? e.email ?? "") || null),
      action: "import",
    });
  }

  return {
    importableIds,
    importableUserIds,
    rows,
    toImport,
    skippedExisting,
    skippedUnknownUser,
    skippedInvalid,
    unknownUserIds: [...unknownUserIds],
  };
}

export async function getExpenseImportPreview(
  supabase: SupabaseLike,
  organizationId: string,
  payload: ExpenseImportPayload,
): Promise<ExpenseImportPreview> {
  const orgProfiles = await fetchOrgProfiles(supabase, organizationId);
  const { byUserId: fileByUserId, byEmployeeId: fileByEmployeeId } = buildProfileMaps(
    payload.profiles ?? [],
  );
  const expenseIds = payload.expenses.map((e) => String(e.id ?? "")).filter(Boolean);
  const existingIds = await fetchExistingExpenseIds(supabase, expenseIds);

  const plan = buildImportPlan(
    payload,
    organizationId,
    existingIds,
    orgProfiles,
    fileByUserId,
    fileByEmployeeId,
  );

  const userIds = collectUserIdsForImport(payload, plan.importableUserIds);
  const profilesToImport = profilesForUsers(
    payload,
    userIds,
    organizationId,
    new Set(orgProfiles.keys()),
  ).filter((p) => !orgProfiles.has(String(p.user_id)));
  const membershipsToImport = membershipsForUsers(payload, userIds, organizationId);

  const lineItems = payload.expense_line_items ?? [];
  const attachments = payload.attachments ?? [];
  const formValues = payload.expense_form_field_values ?? [];
  const auditLogs = payload.audit_logs ?? [];

  const { from, to } = expenseDates(
    payload.expenses.filter((e) => plan.importableIds.has(String(e.id ?? ""))),
  );

  return {
    sourceOrganizationId: payload.sourceOrganizationId ?? payload.organizationId ?? null,
    totalExpenses: payload.expenses.length,
    toImport: plan.toImport,
    skippedExisting: plan.skippedExisting,
    skippedUnknownUser: plan.skippedUnknownUser,
    skippedInvalid: plan.skippedInvalid,
    unknownUserIds: plan.unknownUserIds,
    profilesToImport: profilesToImport.length,
    membershipsToImport: membershipsToImport.length,
    attachments: attachments.filter((a) => plan.importableIds.has(String(a.expense_id ?? ""))).length,
    lineItems: lineItems.filter((a) => plan.importableIds.has(String(a.expense_id ?? ""))).length,
    formFieldValues: formValues.filter((a) => plan.importableIds.has(String(a.expense_id ?? ""))).length,
    auditLogs: auditLogs.filter((a) => plan.importableIds.has(String(a.expense_id ?? ""))).length,
    dataFrom: from,
    dataTo: to,
    rows: plan.rows,
  };
}

async function upsertBatches(
  supabase: SupabaseLike,
  table: string,
  rows: Record<string, unknown>[],
): Promise<string | null> {
  for (const batch of chunk(rows, UPSERT_BATCH)) {
    const { error } = await supabase.from(table).upsert(batch, { onConflict: "id" });
    if (error) return `${table}: ${error.message ?? String(error)}`;
  }
  return null;
}

export async function importExpensesFromJson(
  supabase: SupabaseLike,
  organizationId: string,
  payload: ExpenseImportPayload,
  options?: { skipExisting?: boolean; rewriteAttachmentUrls?: boolean },
): Promise<ExpenseImportResult> {
  const skipExisting = options?.skipExisting !== false;
  const rewriteAttachmentUrls = options?.rewriteAttachmentUrls !== false;

  const result: ExpenseImportResult = {
    success: false,
    imported: 0,
    skippedExisting: 0,
    skippedUnknownUser: 0,
    skippedInvalid: 0,
    profilesImported: 0,
    membershipsImported: 0,
    lineItemsImported: 0,
    attachmentsImported: 0,
    formValuesImported: 0,
    auditLogsImported: 0,
    errors: [],
  };

  let orgProfiles = await fetchOrgProfiles(supabase, organizationId);
  const { byUserId: fileByUserId, byEmployeeId: fileByEmployeeId } = buildProfileMaps(
    payload.profiles ?? [],
  );
  const expenseIds = payload.expenses.map((e) => String(e.id ?? "")).filter(Boolean);
  const existingIds = skipExisting ? await fetchExistingExpenseIds(supabase, expenseIds) : new Set<string>();

  const plan = buildImportPlan(
    payload,
    organizationId,
    existingIds,
    orgProfiles,
    fileByUserId,
    fileByEmployeeId,
  );

  result.skippedExisting = plan.skippedExisting;
  result.skippedUnknownUser = plan.skippedUnknownUser;
  result.skippedInvalid = plan.skippedInvalid;

  if (plan.toImport === 0) {
    result.errors.push("No expenses to import after validation");
    return result;
  }

  const userIds = collectUserIdsForImport(payload, plan.importableUserIds);
  const profilesToUpsert = profilesForUsers(
    payload,
    userIds,
    organizationId,
    new Set(orgProfiles.keys()),
  );
  const membershipsToUpsert = membershipsForUsers(payload, userIds, organizationId);

  if (profilesToUpsert.length > 0) {
    const err = await upsertBatches(supabase, "profiles", profilesToUpsert);
    if (err) {
      result.errors.push(
        `${err}. If users are missing from Auth, create them in User Management first (same user_id UUID).`,
      );
      return result;
    }
    result.profilesImported = profilesToUpsert.length;
    orgProfiles = await fetchOrgProfiles(supabase, organizationId);
  }

  if (membershipsToUpsert.length > 0) {
    const err = await upsertBatches(supabase, "organization_memberships", membershipsToUpsert);
    if (err) {
      result.errors.push(err);
      return result;
    }
    result.membershipsImported = membershipsToUpsert.length;
  }

  const expensesToInsert: Record<string, unknown>[] = [];
  for (const e of payload.expenses) {
    const id = String(e.id ?? "");
    if (!plan.importableIds.has(id)) continue;
    const userId = resolveExpenseUserId(e, fileByUserId, fileByEmployeeId, orgProfiles);
    if (!userId) continue;
    const prepared = prepareExpenseRow(e, organizationId, userId);
    if (prepared) expensesToInsert.push(prepared);
  }

  const errExpenses = await upsertBatches(supabase, "expenses", expensesToInsert);
  if (errExpenses) {
    result.errors.push(errExpenses);
    return result;
  }
  result.imported = expensesToInsert.length;

  const childTables: Array<{
    key: keyof Pick<
      ExpenseImportPayload,
      "expense_line_items" | "attachments" | "expense_form_field_values" | "audit_logs"
    >;
    table: string;
    resultKey: keyof Pick<
      ExpenseImportResult,
      "lineItemsImported" | "attachmentsImported" | "formValuesImported" | "auditLogsImported"
    >;
  }> = [
    { key: "expense_line_items", table: "expense_line_items", resultKey: "lineItemsImported" },
    { key: "attachments", table: "attachments", resultKey: "attachmentsImported" },
    { key: "expense_form_field_values", table: "expense_form_field_values", resultKey: "formValuesImported" },
    { key: "audit_logs", table: "audit_logs", resultKey: "auditLogsImported" },
  ];

  for (const { key, table, resultKey } of childTables) {
    const source = payload[key] ?? [];
    if (source.length === 0) continue;
    const rows = prepareChildRows(source, plan.importableIds, organizationId, rewriteAttachmentUrls);
    if (rows.length === 0) continue;
    const err = await upsertBatches(supabase, table, rows);
    if (err) {
      result.errors.push(err);
      return result;
    }
    result[resultKey] = rows.length;
  }

  result.success = true;
  return result;
}

export function downloadExpenseImportTemplate(): void {
  const a = document.createElement("a");
  a.href = "/templates/expense-import-template.json";
  a.download = "expense-import-template.json";
  a.click();
}
