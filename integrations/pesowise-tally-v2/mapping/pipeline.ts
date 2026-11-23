import { AccountingRegistry } from "./accountingRegistry.ts";
import { decideDelivery, indexDeliveryState } from "./deliveryDecision.ts";
import {
  PESOWISE_METADATA_GROUP_NAME,
  accountingExpenseKey,
  pesowiseMetadataGroupKey,
  reportMetadataDeliveryKey,
  tallyMetadataDeliveryHash,
} from "./identities.ts";
import {
  jobNeedsAccountingBootstrap,
  pesowiseAccountingBootstrapCommands,
} from "./accountingBootstrap.ts";
import { mapPreparedItem } from "./mapPreparedItem.ts";
import { expenseIdFromPrepared } from "./payload.ts";
import type { MapJobOptions, MapJobResult, PreparedJobItem, TallyCommand } from "./types.ts";
import { batchCommandsWithDeliveryUpdates } from "./xml/serialize.ts";

const DEFAULT_BATCH_SIZE = 50;

export type MapPreparedChunkOptions = {
  /** When false, omit PesoWise Metadata group (already added in an earlier chunk). */
  include_metadata_group?: boolean;
};

export function mapPreparedJobItems(
  items: PreparedJobItem[],
  options: MapJobOptions,
  registryIn?: AccountingRegistry,
  chunkOpts?: MapPreparedChunkOptions,
): MapJobResult {
  const stateByKey = indexDeliveryState(options.delivery_state ?? []);
  const registry = registryIn ?? new AccountingRegistry();
  const ordered = [...items].sort((a, b) => a.seq - b.seq);
  const commands: TallyCommand[] = [];

  const presentationOnly = options.presentation_only === true;
  const mapCtx = {
    force_metadata_refresh: options.force_metadata_refresh === true,
    presentation_only: presentationOnly,
    sync_run_id: options.sync_run_id,
  };
  for (const item of ordered) {
    commands.push(...mapPreparedItem(item, registry, stateByKey, mapCtx));
  }

  if (!presentationOnly && jobNeedsAccountingBootstrap(commands)) {
    commands.unshift(...pesowiseAccountingBootstrapCommands(options.organization_id));
  }

  // The shared metadata group is provisioned once during Tally setup. Re-creating
  // it in each report job causes Tally to reject otherwise valid batches.
  const includeGroup = chunkOpts?.include_metadata_group === true;
  if (includeGroup && commands.some((c) => c.kind === "report_metadata")) {
    commands.unshift({
      kind: "master",
      action: "create",
      master: {
        kind: "group",
        stable_key: pesowiseMetadataGroupKey(options.organization_id),
        display_name: PESOWISE_METADATA_GROUP_NAME,
        parent_group: "Primary",
      },
    });
  }

  const decisions: MapJobResult["decisions"] = [];
  for (const item of ordered) {
    const metaKey = reportMetadataDeliveryKey(
      options.organization_id,
      item.payload.report_type,
      item.source_key,
    );
    const metaDeliveryHash = tallyMetadataDeliveryHash(item.content_hash);
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
