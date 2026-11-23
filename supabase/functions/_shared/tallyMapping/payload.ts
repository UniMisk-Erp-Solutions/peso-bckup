import type { PreparedItemPayload } from "./types.ts";

/** Unwrap Phase 3 worker envelope to the authoritative row object. */
export function unwrapPreparedRow(item: PreparedItemPayload): Record<string, unknown> {
  if (item.row && typeof item.row === "object") return item.row as Record<string, unknown>;
  if (item.payload && typeof item.payload === "object") return item.payload as Record<string, unknown>;
  return item as unknown as Record<string, unknown>;
}

export function expenseIdFromPrepared(item: PreparedItemPayload): string | null {
  const row = unwrapPreparedRow(item);
  const fromEnvelope = item.expense_id;
  const fromRow = row.id ?? row.expense_id;
  const id = fromEnvelope ?? fromRow;
  return id == null ? null : String(id);
}
