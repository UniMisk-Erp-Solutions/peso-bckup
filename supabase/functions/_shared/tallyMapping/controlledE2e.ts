import { decideDelivery, indexDeliveryState } from "./deliveryDecision.ts";
import { reportMetadataDeliveryKey } from "./identities.ts";
import { mapDailyMetadataLedgerOnly } from "./mapPreparedItem.ts";
import type { MapJobOptions, MapJobResult, PreparedJobItem } from "./types.ts";
import { batchCommandsWithDeliveryUpdates } from "./xml/serialize.ts";

/** Smoke org only — controlled live E2E. */
export const E2E_CONTROLLED_SMOKE_ORG_ID = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";

export function isE2eControlledSingleMetadataParameters(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== "object") return false;
  return (parameters as { e2e_controlled_single_metadata?: boolean }).e2e_controlled_single_metadata === true;
}

function isDailyRow(item: PreparedJobItem): boolean {
  return item.source_type === "daily_report_row" || item.payload.report_type === "daily_project_report";
}

/**
 * ONE daily row → ONE metadata LEDGER Create TALLYMESSAGE.
 * Assumes PesoWise Metadata group already exists in Tally (prior validation).
 */
export function mapPreparedJobItemsControlledE2e(
  items: PreparedJobItem[],
  options: MapJobOptions,
): MapJobResult {
  if (options.organization_id !== E2E_CONTROLLED_SMOKE_ORG_ID) {
    throw new Error("controlled E2E mapping allowed only for smoke test organization");
  }

  const stateByKey = indexDeliveryState(options.delivery_state ?? []);
  const daily = [...items].filter(isDailyRow).sort((a, b) => a.seq - b.seq);
  if (daily.length !== 1) {
    throw new Error(`controlled E2E requires exactly 1 daily_project_report row, got ${daily.length}`);
  }

  const commands = mapDailyMetadataLedgerOnly(daily[0], options.organization_id, stateByKey);
  if (commands.length !== 1 || commands[0].kind !== "report_metadata") {
    throw new Error("controlled E2E produced no metadata ledger (skip or empty)");
  }

  const metaKey = reportMetadataDeliveryKey(
    options.organization_id,
    "daily_project_report",
    daily[0].source_key,
  );
  const decisions: MapJobResult["decisions"] = [
    {
      delivery_key: metaKey,
      action: decideDelivery(metaKey, daily[0].content_hash, stateByKey),
      content_hash: daily[0].content_hash,
    },
  ];

  const xml_batches = batchCommandsWithDeliveryUpdates(commands, 50);
  if (xml_batches.length !== 1 || xml_batches[0].message_count !== 1) {
    throw new Error(
      `controlled E2E expected 1 batch with 1 message, got ${xml_batches.length} batches / ${xml_batches[0]?.message_count ?? 0} messages`,
    );
  }

  return {
    commands,
    decisions,
    accounting_voucher_count: 0,
    xml_batches,
  };
}
