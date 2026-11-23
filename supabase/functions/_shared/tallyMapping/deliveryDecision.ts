import type { DeliveryAction, DeliveryStateRow } from "./types.ts";

export function decideDelivery(
  deliveryKey: string,
  contentHash: string,
  stateByKey: Map<string, DeliveryStateRow>,
  pesoDeleted?: boolean,
): DeliveryAction {
  if (pesoDeleted) return "cancel_planned";

  const prev = stateByKey.get(deliveryKey);
  if (!prev?.last_content_hash) return "create";
  if (prev.last_content_hash === contentHash) return "skip";
  /** Metadata: append-only new physical version (CREATE), not Tally Alter. */
  return "update";
}

export function indexDeliveryState(rows: DeliveryStateRow[]): Map<string, DeliveryStateRow> {
  return new Map(rows.map((r) => [r.delivery_key, r]));
}
