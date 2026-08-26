import { supabase } from "@/integrations/supabase/client";
import type { ImportMode, ImportRowValidationStatus } from "@/services/BalanceLedgerService";

// DOC-103. Client-side staging for the bulk balance import wizard.
//
// balance_import_batches / balance_import_rows carry an admin-only
// `FOR ALL` RLS policy, so the browser inserts the staged batch+rows
// directly via PostgREST -- this is intentionally NOT privileged: staging a
// draft batch never touches profiles.balance or balance_ledger. Only the
// balance_validate_import_v1 / balance_apply_import_v1 RPCs (in
// BalanceLedgerService) can advance a batch's status or move money, and
// both re-resolve every row's identity fresh from raw_employee_id /
// raw_email -- nothing staged here is trusted as mutation authority.
//
// Not yet in the generated Database types (see BalanceLedgerService.ts) --
// same `as any` convention used throughout this codebase for objects ahead
// of a types regeneration.
const db = supabase as unknown as {
  from: (table: string) => any;
};

export const BALANCE_IMPORT_ARCHIVE_BUCKET = "balance-import-archive";

export interface StagedImportRow {
  rowNumber: number;
  rawEmployeeId: string | null;
  rawEmail: string | null;
  inputAmount: number | null;
  effectiveDate: string | null;
  note: string | null;
}

export interface ImportBatchSummary {
  id: string;
  organization_id: string;
  mode: ImportMode;
  status: string;
  original_filename: string;
  source_storage_path: string | null;
  source_sha256: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
  applied_at: string | null;
  reversed_at: string | null;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  total_delta: number;
}

export type ImportRowConflictStatus = "none" | "conflict" | "resolved" | "skipped";
export type ImportRowConflictType = "opening_balance_exists" | "same_day_anchor_exists" | null;
export type ImportRowResolutionAction = "create" | "add_new_update" | "replace" | "edit" | "skip" | null;

export interface ImportRowDetail {
  id: string;
  row_number: number;
  raw_employee_id: string | null;
  raw_email: string | null;
  matched_user_id: string | null;
  current_balance_snapshot: number | null;
  input_amount: number | null;
  calculated_new_balance: number | null;
  effective_date: string | null;
  note: string | null;
  validation_status: ImportRowValidationStatus | "pending";
  validation_code: string | null;
  validation_message: string | null;
  ledger_entry_id: string | null;
  // Historical Balance Anchors V2 (historical_opening / balance_update modes only).
  historical_position_before: number | null;
  conflict_status: ImportRowConflictStatus;
  conflict_type: ImportRowConflictType;
  resolution_action: ImportRowResolutionAction;
  resolution_target_anchor_id: string | null;
  resolution_reason: string | null;
  resolution_override_balance: number | null;
  resolution_override_effective_date: string | null;
  resolution_override_note: string | null;
  resulting_anchor_id: string | null;
}

function normalizeEmployeeId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/** Upload the original spreadsheet to the private per-org import archive. */
export async function uploadImportSourceFile(params: {
  organizationId: string;
  batchId: string;
  file: File;
}): Promise<string> {
  const path = `${params.organizationId}/${params.batchId}/${params.file.name}`;
  const { error } = await supabase.storage
    .from(BALANCE_IMPORT_ARCHIVE_BUCKET)
    .upload(path, params.file, { upsert: false });
  if (error) {
    throw new Error(`Failed to archive source file: ${error.message}`);
  }
  return path;
}

/** Create a draft import batch (status='draft'). No money moves yet. */
export async function createImportBatch(params: {
  organizationId: string;
  mode: ImportMode;
  originalFilename: string;
  note?: string | null;
}): Promise<ImportBatchSummary> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  const { data, error } = await db
    .from("balance_import_batches")
    .insert({
      organization_id: params.organizationId,
      mode: params.mode,
      original_filename: params.originalFilename,
      note: params.note ?? null,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to create import batch: ${error.message}`);
  }
  return data as ImportBatchSummary;
}

export async function attachSourceStoragePath(
  batchId: string,
  sourceStoragePath: string,
): Promise<void> {
  const { error } = await db
    .from("balance_import_batches")
    .update({ source_storage_path: sourceStoragePath })
    .eq("id", batchId);
  if (error) {
    throw new Error(`Failed to attach archived file to batch: ${error.message}`);
  }
}

export async function attachMappingProfile(batchId: string, mappingProfileId: string): Promise<void> {
  const { error } = await db
    .from("balance_import_batches")
    .update({ mapping_profile_id: mappingProfileId })
    .eq("id", batchId);
  if (error) {
    throw new Error(`Failed to record mapping profile: ${error.message}`);
  }
}

export async function attachSourceSha256(batchId: string, sha256: string): Promise<void> {
  const { error } = await db
    .from("balance_import_batches")
    .update({ source_sha256: sha256 })
    .eq("id", batchId);
  if (error) {
    throw new Error(`Failed to record file hash: ${error.message}`);
  }
}

/**
 * Client-side early check only -- a nicety so the wizard can warn before
 * staging any rows. balance_apply_import_v1 re-checks this authoritatively
 * server-side and is the actual gate against a double-credit.
 */
export async function findDuplicateAppliedBatch(params: {
  organizationId: string;
  mode: ImportMode;
  sha256: string;
}): Promise<ImportBatchSummary | null> {
  const { data, error } = await db
    .from("balance_import_batches")
    .select("*")
    .eq("organization_id", params.organizationId)
    .eq("mode", params.mode)
    .eq("source_sha256", params.sha256)
    .eq("status", "applied")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to check for a duplicate import: ${error.message}`);
  }
  return (data as ImportBatchSummary | null) ?? null;
}

/** Stage every parsed spreadsheet row against a draft batch. */
export async function insertImportRows(
  batchId: string,
  rows: StagedImportRow[],
): Promise<void> {
  const payload = rows.map((row) => ({
    batch_id: batchId,
    row_number: row.rowNumber,
    raw_employee_id: row.rawEmployeeId,
    normalized_employee_id: normalizeEmployeeId(row.rawEmployeeId),
    raw_email: row.rawEmail,
    normalized_email: normalizeEmail(row.rawEmail),
    input_amount: row.inputAmount,
    effective_date: row.effectiveDate,
    note: row.note,
  }));
  const { error } = await db.from("balance_import_rows").insert(payload);
  if (error) {
    throw new Error(`Failed to stage import rows: ${error.message}`);
  }
}

/** Fetch every staged row (with validation results, if validated) for Preview/Details. */
export async function getImportRows(batchId: string): Promise<ImportRowDetail[]> {
  const { data, error } = await db
    .from("balance_import_rows")
    .select("*")
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true });
  if (error) {
    throw new Error(`Failed to load import rows: ${error.message}`);
  }
  return (data ?? []) as ImportRowDetail[];
}

/** Import History listing for one organization, newest first. */
export async function getImportBatches(
  organizationId: string,
  limit = 50,
): Promise<ImportBatchSummary[]> {
  const { data, error } = await db
    .from("balance_import_batches")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Failed to load import history: ${error.message}`);
  }
  return (data ?? []) as ImportBatchSummary[];
}

export async function getImportBatch(batchId: string): Promise<ImportBatchSummary> {
  const { data, error } = await db
    .from("balance_import_batches")
    .select("*")
    .eq("id", batchId)
    .single();
  if (error) {
    throw new Error(`Failed to load import batch: ${error.message}`);
  }
  return data as ImportBatchSummary;
}

export interface ImportMappingProfile {
  id: string;
  organization_id: string;
  name: string;
  header_mapping: Record<string, string>;
  is_default: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Every saved column mapping for an organization, admin-only via RLS. */
export async function listMappingProfiles(organizationId: string): Promise<ImportMappingProfile[]> {
  const { data, error } = await db
    .from("balance_import_mapping_profiles")
    .select("*")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });
  if (error) {
    throw new Error(`Failed to load saved mappings: ${error.message}`);
  }
  return (data ?? []) as ImportMappingProfile[];
}

/**
 * Save the current header->field mapping under a name. If a profile with
 * that name already exists for this organization, its mapping is updated in
 * place (organization_id, name is unique) rather than creating a duplicate.
 */
export async function saveMappingProfile(params: {
  organizationId: string;
  name: string;
  headerMapping: Record<string, string>;
  setDefault: boolean;
}): Promise<ImportMappingProfile> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  const name = params.name.trim();
  if (!name) {
    throw new Error("Mapping name is required");
  }

  if (params.setDefault) {
    await db
      .from("balance_import_mapping_profiles")
      .update({ is_default: false })
      .eq("organization_id", params.organizationId)
      .eq("is_default", true);
  }

  const { data, error } = await db
    .from("balance_import_mapping_profiles")
    .upsert(
      {
        organization_id: params.organizationId,
        name,
        header_mapping: params.headerMapping,
        is_default: params.setDefault,
        created_by: user.id,
      },
      { onConflict: "organization_id,name" },
    )
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to save mapping: ${error.message}`);
  }
  return data as ImportMappingProfile;
}

/** Marks one profile as the organization's default, unsetting any other. */
export async function setDefaultMappingProfile(
  organizationId: string,
  profileId: string,
): Promise<void> {
  const { error: clearError } = await db
    .from("balance_import_mapping_profiles")
    .update({ is_default: false })
    .eq("organization_id", organizationId)
    .eq("is_default", true);
  if (clearError) {
    throw new Error(`Failed to update default mapping: ${clearError.message}`);
  }
  const { error } = await db
    .from("balance_import_mapping_profiles")
    .update({ is_default: true })
    .eq("id", profileId);
  if (error) {
    throw new Error(`Failed to set default mapping: ${error.message}`);
  }
}

export async function deleteMappingProfile(profileId: string): Promise<void> {
  const { error } = await db.from("balance_import_mapping_profiles").delete().eq("id", profileId);
  if (error) {
    throw new Error(`Failed to delete mapping: ${error.message}`);
  }
}

/** Signed URL for an admin to download the archived original source file. */
export async function getImportSourceDownloadUrl(
  sourceStoragePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BALANCE_IMPORT_ARCHIVE_BUCKET)
    .createSignedUrl(sourceStoragePath, 60);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to create download link");
  }
  return data.signedUrl;
}
