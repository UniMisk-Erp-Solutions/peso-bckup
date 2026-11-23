import type { TallySyncReportType } from "@/lib/tallyReportTypes";

/** Versioned contract for future TDL — stored as JSON inside Tally UDF payload. */
export const PESOWISE_TALLY_METADATA_SCHEMA_VERSION = 1;

export type PesowiseTallyMetadataV1 = {
  schema_version: typeof PESOWISE_TALLY_METADATA_SCHEMA_VERSION;
  organization_id: string;
  report_type: TallySyncReportType;
  /** Same as tally delivery_key / reportMetadataDeliveryKey. */
  metadata_delivery_key: string;
  /** Physical immutable ledger name for this (K, content_hash) version. */
  metadata_version_ledger_name: string;
  /** Monotonic revision for K; TDL current row = max(metadata_revision) per K. */
  metadata_revision: number;
  source_key: string;
  content_hash: string;
  accounting_key?: string;
  expense_id?: string;
  event_id?: string;
  user_id?: string;
  project_id?: string;
  manager_approval?: string;
  ho_approval?: string;
  workflow_status?: string;
  fields: Record<string, unknown>;
};

export function buildMetadataV1(input: Omit<PesowiseTallyMetadataV1, "schema_version">): PesowiseTallyMetadataV1 {
  return { schema_version: PESOWISE_TALLY_METADATA_SCHEMA_VERSION, ...input };
}
