import type { DeliveryAction, TallyCommand } from "./types.ts";

/** Payload persisted on ack → `tally_delivery_state` (and metadata revision). */
export type TallyDeliveryUpdate = {
  delivery_key: string;
  delivery_kind: string;
  content_hash: string;
  tally_remote_id?: string | null;
  last_action: DeliveryAction | "create";
  metadata_revision?: number | null;
};

export function deliveryUpdateFromCommand(cmd: TallyCommand): TallyDeliveryUpdate | null {
  if (cmd.kind === "report_metadata") {
    const m = cmd.metadata;
    const rev = (m.payload as { metadata_revision?: number }).metadata_revision;
    return {
      delivery_key: m.metadata_key,
      delivery_kind: "report_metadata",
      content_hash: m.content_hash,
      tally_remote_id: m.ledger_name,
      last_action: rev != null && rev > 1 ? "update" : "create",
      metadata_revision: rev ?? null,
    };
  }
  if (cmd.kind === "voucher") {
    const v = cmd.voucher;
    return {
      delivery_key: v.accounting_key,
      delivery_kind: v.peso_event_id ? "accounting_balance_event" : "accounting_expense",
      content_hash: "",
      tally_remote_id: v.voucher_number ?? null,
      last_action: "create",
    };
  }
  return null;
}

export function deliveryUpdatesFromCommands(commands: TallyCommand[]): TallyDeliveryUpdate[] {
  const out: TallyDeliveryUpdate[] = [];
  for (const c of commands) {
    const u = deliveryUpdateFromCommand(c);
    if (u) out.push(u);
  }
  return out;
}
