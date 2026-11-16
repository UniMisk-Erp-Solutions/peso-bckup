import type { TallySyncReportType } from "@/lib/tallyReportTypes";

export type MetadataLedgerDisplayRow = {
  metadata_delivery_key: string;
  metadata_revision: number;
  report_type: TallySyncReportType;
  organization_id: string;
  content_hash: string;
  ledger_name?: string;
};

/**
 * Keep only the highest metadata_revision per metadata_delivery_key (TDL parity).
 */
export function dedupeLatestMetadataRevisions(
  rows: MetadataLedgerDisplayRow[],
): MetadataLedgerDisplayRow[] {
  const best = new Map<string, MetadataLedgerDisplayRow>();
  for (const row of rows) {
    const k = row.metadata_delivery_key;
    const prev = best.get(k);
    if (!prev || row.metadata_revision > prev.metadata_revision) {
      best.set(k, row);
    }
  }
  return [...best.values()];
}

export function filterRowsByReportType(
  rows: MetadataLedgerDisplayRow[],
  reportType: TallySyncReportType,
): MetadataLedgerDisplayRow[] {
  return rows.filter((r) => r.report_type === reportType);
}

export function assertSingleOrganization(rows: MetadataLedgerDisplayRow[], organizationId: string): void {
  for (const r of rows) {
    if (r.organization_id !== organizationId) {
      throw new Error(`Cross-org row: expected ${organizationId}, got ${r.organization_id}`);
    }
  }
}

export function rowsForTallyReportDisplay(
  rows: MetadataLedgerDisplayRow[],
  reportType: TallySyncReportType,
  organizationId: string,
): MetadataLedgerDisplayRow[] {
  assertSingleOrganization(rows, organizationId);
  const typed = filterRowsByReportType(rows, reportType);
  return dedupeLatestMetadataRevisions(typed);
}
