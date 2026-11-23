import type { DeliveryAction, DeliveryStateRow } from "./types";

/**
 * Monotonic revision per logical metadata key K (not content_hash — hashes are not ordered).
 * TDL current row = max(metadata_revision) for each metadata_delivery_key.
 */
export function expectedMetadataRevision(
  prev: Pick<DeliveryStateRow, "last_content_hash" | "last_metadata_revision"> | undefined,
  newContentHash: string,
): number {
  if (!prev?.last_content_hash) return 1;
  if (prev.last_content_hash === newContentHash) {
    return Math.max(1, prev.last_metadata_revision ?? 1);
  }
  return Math.max(1, (prev.last_metadata_revision ?? 1) + 1);
}

export function nextMetadataRevision(
  metaKey: string,
  decision: DeliveryAction,
  stateByKey: Map<string, DeliveryStateRow>,
  newContentHash: string,
): number {
  const prev = stateByKey.get(metaKey);
  if (decision === "skip" || decision === "cancel_planned") return prev?.last_metadata_revision ?? 0;
  if (decision === "update") return expectedMetadataRevision(prev, newContentHash);
  if (!prev?.last_content_hash) return 1;
  return 1;
}
