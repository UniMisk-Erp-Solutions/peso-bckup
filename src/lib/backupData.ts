/**
 * Backup and restore organization data via Supabase client.
 * Backup = fetch org-scoped tables with pagination, download as JSON.
 * Optional: include receipt files in a ZIP (data.json + receipts/).
 * Restore = parse JSON, validate, upsert in dependency order (batched).
 */

import JSZip from "jszip";

const PAGE_SIZE = 1000;
const RECEIPTS_BUCKET = "receipts";
const UPSERT_BATCH = 80;
/** Smaller batches for tables where RLS-heavy client upserts can hit statement_timeout. */
const RESTORE_BATCH_BY_TABLE: Record<string, number> = {
  expense_form_field_values: 150,
  audit_logs: 30,
  attachments: 30,
  expense_line_items: 40,
  expenses: 50,
};

export interface BackupPayload {
  exportedAt: string;
  organizationId: string;
  /** Current organization row (name, slug, etc.) for full recovery */
  organization: Record<string, unknown> | null;
  /** All users (profiles) in this org */
  profiles: Record<string, unknown>[];
  /** User roles for org members (user_roles where user_id in org members) */
  user_roles: Record<string, unknown>[];
  organization_memberships: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  engineer_locations: Record<string, unknown>[];
  organization_settings: Record<string, unknown>[];
  expenses: Record<string, unknown>[];
  expense_line_items: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  audit_logs: Record<string, unknown>[];
  expense_form_field_values: Record<string, unknown>[];
  expense_categories: Record<string, unknown>[];
  cash_transfer_history: Record<string, unknown>[];
  teams?: Record<string, unknown>[];
  team_members?: Record<string, unknown>[];
}

/** Full-site backup for master admin: organizations + per-org data + global tables. */
export interface FullBackupPayload {
  exportedAt: string;
  type: "full";
  organizations: Record<string, unknown>[];
  master_admin_memberships: Record<string, unknown>[];
  contact_leads: Record<string, unknown>[];
  dataByOrganization: Record<string, Omit<BackupPayload, "exportedAt">>;
}

// Supabase client shape used for backup/restore (avoids pulling in full generated types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any;

async function fetchTablePaginated(
  supabase: SupabaseLike,
  table: string,
  organizationId: string,
  orderBy?: string
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    let q = supabase.from(table).select("*").eq("organization_id", organizationId);
    if (orderBy) q = q.order(orderBy, { ascending: true });
    const { data, error } = await q.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(String(error));
    const list = Array.isArray(data) ? data : [];
    list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
    hasMore = list.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }
  return rows;
}

/** Fetch cash_transfer_history by organization_id (table has it for RLS). */
async function fetchCashTransferHistory(
  supabase: SupabaseLike,
  organizationId: string
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;
  try {
    while (hasMore) {
      const { data, error } = await supabase
        .from("cash_transfer_history")
        .select("*")
        .eq("organization_id", organizationId)
        .order("transferred_at", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(String(error));
      const list = Array.isArray(data) ? data : [];
      list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
      hasMore = list.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }
  } catch (e) {
    if (String(e).includes("does not exist") || String(e).includes("relation")) return [];
    throw e;
  }
  return rows;
}

/** Fetch expense_categories for org (or all if no org column). */
async function fetchExpenseCategories(
  supabase: SupabaseLike,
  organizationId: string
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;
  try {
    while (hasMore) {
      const { data, error } = await supabase
        .from("expense_categories")
        .select("*")
        .eq("organization_id", organizationId)
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error((error as { message?: string }).message ?? String(error));
      const list = Array.isArray(data) ? data : [];
      list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
      hasMore = list.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    if (msg.includes("organization_id") || msg.includes("column")) {
      const { data } = await supabase.from("expense_categories").select("*").range(0, PAGE_SIZE - 1);
      const list = Array.isArray(data) ? data : [];
      list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
    } else throw e;
  }
  return rows;
}

/** Fetch rows from a table by expense_id IN (ids), paginated by id list chunks. */
async function fetchByExpenseIds(
  supabase: SupabaseLike,
  table: string,
  expenseIds: string[],
  orderBy?: string
): Promise<Record<string, unknown>[]> {
  if (expenseIds.length === 0) return [];
  const rows: Record<string, unknown>[] = [];
  const chunkSize = 100;
  for (let i = 0; i < expenseIds.length; i += chunkSize) {
    const ids = expenseIds.slice(i, i + chunkSize);
    let q = supabase.from(table).select("*").in("expense_id", ids);
    if (orderBy) q = q.order(orderBy, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(String(error));
    const list = Array.isArray(data) ? data : [];
    list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
  }
  return rows;
}

/** Fetch single organization row by id. */
async function fetchOrganizationById(
  supabase: SupabaseLike,
  organizationId: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) return null;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

/** Fetch user_roles where user_id in (userIds). */
async function fetchUserRolesByUserIds(
  supabase: SupabaseLike,
  userIds: string[]
): Promise<Record<string, unknown>[]> {
  if (userIds.length === 0) return [];
  const rows: Record<string, unknown>[] = [];
  const chunkSize = 100;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const ids = userIds.slice(i, i + chunkSize);
    const { data, error } = await supabase.from("user_roles").select("*").in("user_id", ids);
    if (error) return rows;
    const list = Array.isArray(data) ? data : [];
    list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
  }
  return rows;
}

/** Fetch engineer_locations where location_id in (locationIds). */
async function fetchEngineerLocationsByLocationIds(
  supabase: SupabaseLike,
  locationIds: string[]
): Promise<Record<string, unknown>[]> {
  if (locationIds.length === 0) return [];
  const rows: Record<string, unknown>[] = [];
  const chunkSize = 100;
  for (let i = 0; i < locationIds.length; i += chunkSize) {
    const ids = locationIds.slice(i, i + chunkSize);
    const { data, error } = await supabase.from("engineer_locations").select("*").in("location_id", ids);
    if (error) return rows;
    const list = Array.isArray(data) ? data : [];
    list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
  }
  return rows;
}

/** Fetch organization_settings for org (table may not exist). */
async function fetchOrganizationSettings(
  supabase: SupabaseLike,
  organizationId: string
): Promise<Record<string, unknown>[]> {
  try {
    const { data, error } = await supabase
      .from("organization_settings")
      .select("*")
      .eq("organization_id", organizationId);
    if (error) return [];
    const list = Array.isArray(data) ? data : [];
    return list.map((r) => (typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
  } catch {
    return [];
  }
}

export async function fetchOrgBackup(
  supabase: SupabaseLike,
  organizationId: string
): Promise<BackupPayload> {
  const [
    organization,
    expenses,
    profiles,
    audit_logs,
    organization_memberships,
    locations,
    organization_settings,
    expense_form_field_values,
    expense_categories,
    cash_transfer_history,
    teams,
    team_members,
  ] = await Promise.all([
    fetchOrganizationById(supabase, organizationId),
    fetchTablePaginated(supabase, "expenses", organizationId, "created_at"),
    fetchTablePaginated(supabase, "profiles", organizationId),
    fetchTablePaginated(supabase, "audit_logs", organizationId, "created_at"),
    fetchTablePaginated(supabase, "organization_memberships", organizationId),
    fetchTablePaginated(supabase, "locations", organizationId),
    fetchOrganizationSettings(supabase, organizationId),
    fetchTablePaginated(supabase, "expense_form_field_values", organizationId),
    fetchExpenseCategories(supabase, organizationId),
    fetchCashTransferHistory(supabase, organizationId),
    fetchTablePaginated(supabase, "teams", organizationId),
    fetchTablePaginated(supabase, "team_members", organizationId),
  ]);

  const userIds = [...new Set((organization_memberships as { user_id?: string }[]).map((m) => m.user_id).filter(Boolean))] as string[];
  const locationIds = locations.map((l) => String(l.id)).filter(Boolean);
  const [user_roles, engineer_locations] = await Promise.all([
    fetchUserRolesByUserIds(supabase, userIds),
    fetchEngineerLocationsByLocationIds(supabase, locationIds),
  ]);

  const expenseIds = expenses.map((e) => String(e.id)).filter(Boolean);
  let expense_line_items: Record<string, unknown>[];
  let attachments: Record<string, unknown>[];
  try {
    [expense_line_items, attachments] = await Promise.all([
      fetchTablePaginated(supabase, "expense_line_items", organizationId, "date"),
      fetchTablePaginated(supabase, "attachments", organizationId, "created_at"),
    ]);
  } catch {
    [expense_line_items, attachments] = await Promise.all([
      fetchByExpenseIds(supabase, "expense_line_items", expenseIds, "date"),
      fetchByExpenseIds(supabase, "attachments", expenseIds, "created_at"),
    ]);
  }

  return {
    exportedAt: new Date().toISOString(),
    organizationId,
    organization,
    profiles,
    user_roles,
    organization_memberships,
    locations,
    engineer_locations,
    organization_settings,
    expenses,
    expense_line_items,
    attachments,
    audit_logs,
    expense_form_field_values,
    expense_categories,
    cash_transfer_history,
    teams,
    team_members,
  };
}

/** Extract storage path (key inside bucket) from attachment file_url. Bucket is "receipts". */
function getStoragePathFromFileUrl(fileUrl: string): string | null {
  if (!fileUrl || typeof fileUrl !== "string") return null;
  const s = fileUrl.trim();
  const receiptsPrefix = "/object/public/receipts/";
  const legacyPrefix = "/object/public/expense-attachments/";
  if (s.includes(receiptsPrefix)) {
    const i = s.indexOf(receiptsPrefix);
    return s.substring(i + receiptsPrefix.length).split("?")[0] || null;
  }
  if (s.includes(legacyPrefix)) {
    const i = s.indexOf(legacyPrefix);
    return s.substring(i + legacyPrefix.length).split("?")[0] || null;
  }
  if (s.startsWith("receipts/") || s.startsWith("expense-attachments/")) {
    const path = s.replace(/^expense-attachments\//, "receipts/");
    return path.startsWith("receipts/") ? path.substring(8) : path;
  }
  return null;
}

/** Download one attachment file from Storage. Returns blob or null on failure. */
async function downloadAttachmentBlob(
  supabase: SupabaseLike,
  fileUrl: string
): Promise<Blob | null> {
  const path = getStoragePathFromFileUrl(fileUrl);
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).download(path);
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

export interface ReceiptBlob {
  attachmentId: string;
  filename: string;
  blob: Blob;
}

/** Download all receipt files for the given attachment rows. Skips failures. */
export async function fetchReceiptBlobs(
  supabase: SupabaseLike,
  attachments: Record<string, unknown>[]
): Promise<ReceiptBlob[]> {
  const results: ReceiptBlob[] = [];
  for (const row of attachments) {
    const id = String(row.id ?? "");
    const fileUrl = String(row.file_url ?? "");
    const filename = String(row.filename ?? "file");
    if (!fileUrl) continue;
    const blob = await downloadAttachmentBlob(supabase, fileUrl);
    if (blob) results.push({ attachmentId: id, filename, blob });
  }
  return results;
}

/** Create a ZIP containing data.json and receipts (by attachment id). */
export async function createBackupZip(
  payload: BackupPayload,
  receiptBlobs: ReceiptBlob[]
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("data.json", JSON.stringify(payload, null, 2), { binary: false });
  const receiptsFolder = zip.folder("receipts");
  if (receiptsFolder) {
    for (const { attachmentId, filename, blob } of receiptBlobs) {
      const safeName = `${attachmentId}_${filename}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      receiptsFolder.file(safeName, blob, { binary: true });
    }
  }
  return zip.generateAsync({ type: "blob" });
}

/** Trigger download of backup as ZIP (data + receipts). */
export async function downloadBackupWithReceipts(
  payload: BackupPayload,
  receiptBlobs: ReceiptBlob[]
): Promise<void> {
  const zipBlob = await createBackupZip(payload, receiptBlobs);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = getBackupDownloadFilename(payload, { zip: true });
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadBackup(payload: BackupPayload): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = getBackupDownloadFilename(payload, { zip: false });
  a.click();
  URL.revokeObjectURL(url);
}

/** Fetch all rows from a table with no filter (for master admin full backup). */
async function fetchTableAllPaginated(
  supabase: SupabaseLike,
  table: string,
  orderBy?: string
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    let q = supabase.from(table).select("*");
    if (orderBy) q = q.order(orderBy, { ascending: true });
    const { data, error } = await q.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(String(error));
    const list = Array.isArray(data) ? data : [];
    list.forEach((r) => rows.push(typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}));
    hasMore = list.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }
  return rows;
}

/**
 * Fetch full website backup (all organizations + their data). For master admin only.
 * Uses the same Supabase client; RLS must allow master admin to read all orgs.
 */
export async function fetchFullBackup(supabase: SupabaseLike): Promise<FullBackupPayload> {
  const [organizations, masterAdminRows, contactLeads] = await Promise.all([
    fetchTableAllPaginated(supabase, "organizations", "created_at"),
    (async () => {
      try {
        return await fetchTableAllPaginated(supabase, "master_admin_memberships", "created_at");
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        return await fetchTableAllPaginated(supabase, "contact_leads", "created_at");
      } catch {
        return [];
      }
    })(),
  ]);

  const dataByOrganization: Record<string, Omit<BackupPayload, "exportedAt">> = {};
  for (const org of organizations) {
    const orgId = String(org.id ?? "");
    if (!orgId) continue;
    try {
      const payload = await fetchOrgBackup(supabase, orgId);
      const { exportedAt: _, ...rest } = payload;
      dataByOrganization[orgId] = rest;
    } catch (e) {
      console.warn(`Failed to backup org ${orgId}:`, e);
      dataByOrganization[orgId] = {
        organizationId: orgId,
        organization: null,
        profiles: [],
        user_roles: [],
        organization_memberships: [],
        locations: [],
        engineer_locations: [],
        organization_settings: [],
        expenses: [],
        expense_line_items: [],
        attachments: [],
        audit_logs: [],
        expense_form_field_values: [],
        expense_categories: [],
        cash_transfer_history: [],
      };
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    type: "full",
    organizations,
    master_admin_memberships: masterAdminRows,
    contact_leads: contactLeads,
    dataByOrganization,
  };
}

export function downloadFullBackup(payload: FullBackupPayload): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backup-full-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Create ZIP for full backup with receipts: data.json + receipts/{orgId}/{attachmentId}_{filename}. */
export async function createFullBackupZip(
  payload: FullBackupPayload,
  receiptsByOrg: Record<string, ReceiptBlob[]>
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("data.json", JSON.stringify(payload, null, 2), { binary: false });
  const receiptsRoot = zip.folder("receipts");
  if (receiptsRoot) {
    for (const [orgId, blobs] of Object.entries(receiptsByOrg)) {
      if (blobs.length === 0) continue;
      const orgFolder = receiptsRoot.folder(orgId);
      if (orgFolder) {
        for (const { attachmentId, filename, blob } of blobs) {
          const safeName = `${attachmentId}_${filename}`.replace(/[^a-zA-Z0-9._-]/g, "_");
          orgFolder.file(safeName, blob, { binary: true });
        }
      }
    }
  }
  return zip.generateAsync({ type: "blob" });
}

/** Trigger download of full backup as ZIP (data + receipts per org). */
export async function downloadFullBackupWithReceipts(
  payload: FullBackupPayload,
  receiptsByOrg: Record<string, ReceiptBlob[]>
): Promise<void> {
  const zipBlob = await createFullBackupZip(payload, receiptsByOrg);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backup-full-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, "-")}-with-receipts.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isRestoreTimeoutError(error: unknown): boolean {
  const msg = (error as { message?: string })?.message ?? String(error);
  return /timeout|statement timeout|57014/i.test(msg);
}

function isMissingRestoreRpc(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return (
    e?.code === "PGRST202" ||
    e?.code === "42883" ||
    /admin_restore_upsert_form_field_values/i.test(e?.message ?? "")
  );
}

async function restoreTableBatch(
  supabase: SupabaseLike,
  table: string,
  batch: Record<string, unknown>[],
  organizationId: string,
): Promise<{ error: unknown | null }> {
  if (table === "expense_form_field_values") {
    const { error } = await supabase.rpc("admin_restore_upsert_form_field_values", {
      p_organization_id: organizationId,
      p_rows: batch,
    });
    if (!error || !isMissingRestoreRpc(error)) {
      return { error };
    }
  }

  const { error } = await supabase.from(table).upsert(batch, { onConflict: "id" });
  return { error };
}

async function restoreTableRows(
  supabase: SupabaseLike,
  table: string,
  rows: Record<string, unknown>[],
  organizationId: string,
): Promise<{ error?: string }> {
  let batchSize = RESTORE_BATCH_BY_TABLE[table] ?? UPSERT_BATCH;

  let index = 0;
  while (index < rows.length) {
    const batch = rows.slice(index, index + batchSize);
    const { error } = await restoreTableBatch(supabase, table, batch, organizationId);

    if (error && isRestoreTimeoutError(error) && batchSize > 1) {
      batchSize = Math.max(1, Math.floor(batchSize / 2));
      continue;
    }

    if (error) {
      return {
        error: `${table}: ${(error as { message?: string }).message ?? String(error)}`,
      };
    }

    index += batch.length;
  }

  return {};
}

/** Preview summary for a backup payload: counts and date range of data. */
export interface BackupPreview {
  counts: {
    expenses: number;
    profiles: number;
    organization_memberships: number;
    expense_line_items: number;
    attachments: number;
    audit_logs: number;
    expense_form_field_values: number;
    expense_categories: number;
    cash_transfer_history: number;
    locations: number;
    engineer_locations: number;
    user_roles: number;
    organization_settings: number;
  };
  /** Earliest date in the backup data (expenses, transfers, etc.). */
  dataFrom: string | null;
  /** Latest date in the backup data. */
  dataTo: string | null;
  exportedAt: string;
  organizationName: string;
}

/** Build a preview (counts + date range) from a backup payload for restore confirmation. */
export function getBackupPreview(payload: BackupPayload): BackupPreview {
  const expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
  const transfers = Array.isArray(payload.cash_transfer_history) ? payload.cash_transfer_history : [];
  const auditLogs = Array.isArray(payload.audit_logs) ? payload.audit_logs : [];

  const dates: string[] = [];
  for (const e of expenses) {
    const r = e as Record<string, unknown>;
    if (r.trip_start) dates.push(String(r.trip_start));
    if (r.trip_end) dates.push(String(r.trip_end));
    if (r.created_at) dates.push(String(r.created_at));
  }
  for (const t of transfers) {
    const r = t as Record<string, unknown>;
    if (r.transferred_at) dates.push(String(r.transferred_at));
  }
  for (const a of auditLogs) {
    const r = a as Record<string, unknown>;
    if (r.created_at) dates.push(String(r.created_at));
  }

  let dataFrom: string | null = null;
  let dataTo: string | null = null;
  if (dates.length > 0) {
    const sorted = [...dates].sort();
    dataFrom = sorted[0];
    dataTo = sorted[sorted.length - 1];
  }

  const org = payload.organization && typeof payload.organization === "object" ? (payload.organization as Record<string, unknown>) : null;
  const organizationName = (org?.name && String(org.name).trim()) ? String(org.name).trim() : "Organization";

  return {
    counts: {
      expenses: expenses.length,
      profiles: Array.isArray(payload.profiles) ? payload.profiles.length : 0,
      organization_memberships: Array.isArray(payload.organization_memberships) ? payload.organization_memberships.length : 0,
      expense_line_items: Array.isArray(payload.expense_line_items) ? payload.expense_line_items.length : 0,
      attachments: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
      audit_logs: auditLogs.length,
      expense_form_field_values: Array.isArray(payload.expense_form_field_values) ? payload.expense_form_field_values.length : 0,
      expense_categories: Array.isArray(payload.expense_categories) ? payload.expense_categories.length : 0,
      cash_transfer_history: transfers.length,
      locations: Array.isArray(payload.locations) ? payload.locations.length : 0,
      engineer_locations: Array.isArray(payload.engineer_locations) ? payload.engineer_locations.length : 0,
      user_roles: Array.isArray(payload.user_roles) ? payload.user_roles.length : 0,
      organization_settings: Array.isArray(payload.organization_settings) ? payload.organization_settings.length : 0,
    },
    dataFrom,
    dataTo,
    exportedAt: payload.exportedAt ?? new Date().toISOString(),
    organizationName,
  };
}

/** Build backup download filename: Pesowise_Backup_<Company>_<from>_to_<to>_exported_<date>.json|zip */
export function getBackupDownloadFilename(payload: BackupPayload, options: { zip?: boolean } = {}): string {
  const preview = getBackupPreview(payload);
  const company = preview.organizationName.replace(/[^a-zA-Z0-9-_]/g, "_").replace(/_+/g, "_") || "Organization";
  const ext = options.zip ? "zip" : "json";

  const exportedPart = preview.exportedAt
    ? new Date(preview.exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, "-")
    : new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  if (preview.dataFrom && preview.dataTo) {
    const fromStr = preview.dataFrom.slice(0, 10).replace(/-/g, "");
    const toStr = preview.dataTo.slice(0, 10).replace(/-/g, "");
    return `Pesowise_Backup_${company}_${fromStr}_to_${toStr}_exported_${exportedPart}.${ext}`;
  }
  return `Pesowise_Backup_${company}_exported_${exportedPart}.${ext}`;
}

export function parseBackupFile(file: File): Promise<BackupPayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = reader.result as string;
        const data = JSON.parse(raw) as unknown;
        if (!data || typeof data !== "object" || !("organizationId" in data) || !("expenses" in data)) {
          reject(new Error("Invalid backup file: missing organizationId or expenses"));
          return;
        }
        const payload = data as BackupPayload;
        if (payload.organization !== null && typeof payload.organization !== "object") payload.organization = null;
        if (!Array.isArray(payload.profiles)) payload.profiles = [];
        if (!Array.isArray(payload.user_roles)) payload.user_roles = [];
        if (!Array.isArray(payload.organization_memberships)) payload.organization_memberships = [];
        if (!Array.isArray(payload.locations)) payload.locations = [];
        if (!Array.isArray(payload.engineer_locations)) payload.engineer_locations = [];
        if (!Array.isArray(payload.organization_settings)) payload.organization_settings = [];
        if (!Array.isArray(payload.expenses)) payload.expenses = [];
        if (!Array.isArray(payload.expense_line_items)) payload.expense_line_items = [];
        if (!Array.isArray(payload.attachments)) payload.attachments = [];
        if (!Array.isArray(payload.audit_logs)) payload.audit_logs = [];
        if (!Array.isArray(payload.expense_form_field_values)) payload.expense_form_field_values = [];
        if (!Array.isArray(payload.expense_categories)) payload.expense_categories = [];
        if (!Array.isArray(payload.cash_transfer_history)) payload.cash_transfer_history = [];
        resolve(payload);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file, "utf-8");
  });
}

export async function restoreFromBackup(
  supabase: SupabaseLike,
  organizationId: string,
  file: File
): Promise<{ success: boolean; error?: string }> {
  let payload: BackupPayload;
  try {
    payload = await parseBackupFile(file);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Invalid backup file" };
  }
  if (payload.organizationId !== organizationId) {
    return { success: false, error: "Backup is for a different organization. Restore only allowed for the same organization." };
  }

  if (payload.organization && typeof payload.organization === "object") {
    const { error } = await supabase.from("organizations").upsert(payload.organization, { onConflict: "id" });
    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      if (msg.includes("row-level security") || msg.includes("policy")) {
        // RLS blocks client from writing to organizations; skip and continue with rest of restore
      } else {
        return { success: false, error: `organizations: ${msg}` };
      }
    }
  }

  const tables: (keyof Omit<BackupPayload, "exportedAt" | "organizationId" | "organization">)[] = [
    "profiles",
    "user_roles",
    "organization_memberships",
    "locations",
    "engineer_locations",
    "teams",
    "team_members",
    "organization_settings",
    "expenses",
    "expense_line_items",
    "attachments",
    "audit_logs",
    "expense_form_field_values",
    "expense_categories",
    "cash_transfer_history",
  ];

  for (const table of tables) {
    const rows = payload[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const result = await restoreTableRows(supabase, table, rows as Record<string, unknown>[], organizationId);
    if (result.error) return { success: false, error: result.error };
  }
  return { success: true };
}
