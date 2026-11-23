import type { PesowiseTallyMetadataV1 } from "@/lib/tallyMapping/metadataSchema";
import type { LedgerDisplayUdf } from "@/lib/tallyMapping/dailyProjectLedgerUdks";
import {
  PESOWISE_META_REVISION_UDF_INDEX,
  PESOWISE_REPORT_TYPE_UDF_INDEX,
} from "@/lib/tallyMapping/dailyProjectLedgerUdks";

export type LedgerDisplayUdf = { name: string; index: string; value: string };

/** UDF indices shared by all report metadata ledgers. */
export const PESOWISE_META_DELIVERY_KEY_UDF_INDEX = "25005";
export const PESOWISE_REPORT_FLAT_ROW_UDF_INDEX = "25028";
export const PESOWISE_SYNC_RUN_UDF_INDEX = "25030";

export function buildCommonMetaDisplayUdks(
  meta: PesowiseTallyMetadataV1,
  flatRow: string,
  syncRunId?: string,
): LedgerDisplayUdf[] {
  const udks: LedgerDisplayUdf[] = [
    {
      name: "PESOWISE_REPORT_TYPE",
      index: PESOWISE_REPORT_TYPE_UDF_INDEX,
      value: String(meta.report_type),
    },
    {
      name: "PESOWISE_META_REVISION",
      index: PESOWISE_META_REVISION_UDF_INDEX,
      value: String(meta.metadata_revision),
    },
    {
      name: "PESOWISE_META_DELIVERY_KEY",
      index: PESOWISE_META_DELIVERY_KEY_UDF_INDEX,
      value: String(meta.metadata_delivery_key),
    },
    {
      name: "PESOWISE_REPORT_FLAT_ROW",
      index: PESOWISE_REPORT_FLAT_ROW_UDF_INDEX,
      value: flatRow,
    },
  ];
  if (syncRunId) {
    udks.push({
      name: "PESOWISE_SYNC_RUN_ID",
      index: PESOWISE_SYNC_RUN_UDF_INDEX,
      value: syncRunId,
    });
  }
  return udks;
}
