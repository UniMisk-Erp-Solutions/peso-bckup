import type { BulkUserCsvRow, BulkUserCsvRole } from "@/lib/bulkUsersCsv";

/** Keep edge function requests small to avoid gateway / worker timeouts on Coolify. */
export const BULK_USERS_IMPORT_CHUNK_SIZE = 30;

/** Import managers before employees so supervisor employee IDs resolve within each batch. */
const BULK_IMPORT_ROLE_ORDER: Record<BulkUserCsvRole, number> = {
  admin: 0,
  engineer: 1,
  cashier: 2,
  team_leader: 3,
  executive: 4,
  employee: 5,
};

export function sortBulkImportRows(rows: BulkUserCsvRow[]): BulkUserCsvRow[] {
  return [...rows].sort(
    (a, b) => (BULK_IMPORT_ROLE_ORDER[a.role] ?? 99) - (BULK_IMPORT_ROLE_ORDER[b.role] ?? 99),
  );
}

export type BulkUsersImportRowResult = {
  index: number;
  ok: boolean;
  email?: string;
  employee_id?: string;
  user_id?: string;
  action?: string;
  warnings?: string[];
  error?: string;
};

export type BulkUsersImportResponse = {
  success?: boolean;
  organization_id?: string;
  dry_run?: boolean;
  total?: number;
  ok?: number;
  failed?: number;
  results?: BulkUsersImportRowResult[];
  error?: string;
  chunks?: number;
  supervisor_link?: {
    linked?: number;
    skipped?: number;
    warnings?: string[];
  };
  password_sync?: {
    updated?: number;
    skipped?: number;
    warnings?: string[];
  };
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runBulkUsersImportInChunks(params: {
  organizationId: string;
  dryRun: boolean;
  rows: BulkUserCsvRow[];
  chunkSize?: number;
  invoke: (body: Record<string, unknown>) => Promise<BulkUsersImportResponse>;
  onProgress?: (progress: { completed: number; total: number; chunk: number; chunks: number }) => void;
}): Promise<BulkUsersImportResponse> {
  const { organizationId, dryRun, rows, invoke, onProgress } = params;
  const chunkSize = params.chunkSize ?? BULK_USERS_IMPORT_CHUNK_SIZE;
  const sortedRows = sortBulkImportRows(rows);
  const batches = chunk(sortedRows, chunkSize);

  if (batches.length === 0) {
    return { success: true, total: 0, ok: 0, failed: 0, results: [], chunks: 0 };
  }

  const mergedResults: BulkUsersImportRowResult[] = [];
  let ok = 0;
  let failed = 0;

  for (let chunkIndex = 0; chunkIndex < batches.length; chunkIndex += 1) {
    const batch = batches[chunkIndex];
    const rowOffset = chunkIndex * chunkSize;

    const data = await invoke({
      organization_id: organizationId,
      dry_run: dryRun,
      skip_welcome_email: true,
      row_offset: rowOffset,
      rows: batch,
    });

    if (!data?.success && data?.error) {
      throw new Error(
        batches.length > 1
          ? `Import failed on batch ${chunkIndex + 1} of ${batches.length} (rows ${rowOffset + 1}–${rowOffset + batch.length}): ${data.error}`
          : data.error,
      );
    }

    for (const row of data.results || []) {
      mergedResults.push(row);
      if (row.ok) ok += 1;
      else failed += 1;
    }

    onProgress?.({
      completed: Math.min(rowOffset + batch.length, rows.length),
      total: rows.length,
      chunk: chunkIndex + 1,
      chunks: batches.length,
    });
  }

  mergedResults.sort((a, b) => a.index - b.index);

  let supervisorLink: BulkUsersImportResponse["supervisor_link"];
  const needsSupervisorPass = rows.some(
    (r) => r.immediate_supervisor_employee_id || r.immediate_supervisor_email || r.assigned_manager_email,
  );
  if (needsSupervisorPass) {
    const linkData = await invoke({
      organization_id: organizationId,
      dry_run: dryRun,
      skip_welcome_email: true,
      link_supervisors_only: true,
      rows: sortedRows,
    });
    supervisorLink = {
      linked: Number(linkData.linked ?? 0),
      skipped: Number(linkData.skipped ?? 0),
      warnings: Array.isArray(linkData.warnings) ? linkData.warnings : [],
    };
  }

  let passwordSync: BulkUsersImportResponse["password_sync"];
  const needsPasswordSync = rows.some((r) => r.password);
  if (needsPasswordSync) {
    const passwordData = await invoke({
      organization_id: organizationId,
      dry_run: dryRun,
      skip_welcome_email: true,
      sync_passwords_only: true,
      rows: sortedRows,
    });
    passwordSync = {
      updated: Number(passwordData.updated ?? 0),
      skipped: Number(passwordData.skipped ?? 0),
      warnings: Array.isArray(passwordData.warnings) ? passwordData.warnings : [],
    };
  }

  return {
    success: true,
    organization_id: organizationId,
    dry_run: dryRun,
    total: rows.length,
    ok,
    failed,
    results: mergedResults,
    chunks: batches.length,
    supervisor_link: supervisorLink,
    password_sync: passwordSync,
  };
}
