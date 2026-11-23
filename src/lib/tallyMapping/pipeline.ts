import { AccountingRegistry } from "./accountingRegistry";
import { decideDelivery, indexDeliveryState } from "./deliveryDecision";
import {
  accountingExpenseKey,
  reportMetadataDeliveryKey,
  tallyReportMetadataDeliveryHash,
} from "./identities";
import {
  jobNeedsAccountingBootstrap,
  pesowiseAccountingBootstrapCommands,
} from "./accountingBootstrap";
import { mapPreparedItem } from "./mapPreparedItem";
import { expenseIdFromPrepared } from "./payload";
import type { MapJobOptions, MapJobResult, PreparedJobItem, TallyCommand } from "./types";
import { batchCommandsWithDeliveryUpdates } from "./xml/serialize";

const DEFAULT_BATCH_SIZE = 50;

export function mapPreparedJobItems(
  items: PreparedJobItem[],
  options: MapJobOptions,
): MapJobResult {
  const stateByKey = indexDeliveryState(options.delivery_state ?? []);
  const registry = new AccountingRegistry();
  const ordered = [...items].sort((a, b) => a.seq - b.seq);
  const commands: TallyCommand[] = [];

  const presentationOnly = options.presentation_only === true;
  const mapCtx = {
    presentation_only: presentationOnly,
    sync_run_id: options.sync_run_id,
  };
  for (const item of ordered) {
    commands.push(...mapPreparedItem(item, registry, stateByKey, mapCtx));
  }

  if (!presentationOnly && jobNeedsAccountingBootstrap(commands)) {
    commands.unshift(...pesowiseAccountingBootstrapCommands(options.organization_id));
  }

  const decisions: MapJobResult["decisions"] = [];
  for (const item of ordered) {
    const metaKey = reportMetadataDeliveryKey(
      options.organization_id,
      item.payload.report_type,
      item.source_key,
    );
    const metaDeliveryHash = tallyReportMetadataDeliveryHash(item.content_hash, item.payload.report_type);
    decisions.push({
      delivery_key: metaKey,
      action: decideDelivery(metaKey, metaDeliveryHash, stateByKey),
      content_hash: metaDeliveryHash,
    });
    if (!presentationOnly) {
      const expenseId = expenseIdFromPrepared(item.payload);
      if (expenseId) {
        const acctKey = accountingExpenseKey(options.organization_id, expenseId);
        decisions.push({
          delivery_key: acctKey,
          action: decideDelivery(acctKey, item.content_hash, stateByKey),
          content_hash: item.content_hash,
        });
      }
    }
  }

  const batchSize = options.batch_size ?? DEFAULT_BATCH_SIZE;
  const xml_batches = batchCommandsWithDeliveryUpdates(commands, batchSize);

  return {
    commands,
    decisions,
    accounting_voucher_count: registry.totalAccountingVouchers(),
    xml_batches,
  };
}
