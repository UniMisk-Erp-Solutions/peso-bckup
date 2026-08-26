import { supabase } from "@/integrations/supabase/client";
import { formatINR } from "@/lib/format";
import { validateTransferRejectionReason } from "@/lib/balanceTransferOfferValidation";
import { createNotification } from "@/services/NotificationService";

export type BalanceTransferOfferStatus = "pending" | "accepted" | "rejected" | "cancelled";

export type BalanceTransferOffer = {
  id: string;
  organization_id: string;
  transferrer_id: string;
  transferrer_role: string;
  recipient_id: string;
  recipient_role: string;
  amount: number;
  status: BalanceTransferOfferStatus;
  payment_mode: "cash" | "bank_transfer";
  source_bank_account_id: string | null;
  source_bank_name_snapshot: string | null;
  transfer_type: string;
  note: string | null;
  rejection_reason: string | null;
  proposed_at: string;
  responded_at: string | null;
  responded_by: string | null;
  transferrer_name?: string;
  recipient_name?: string;
};

export class BalanceTransferOfferService {
  private static async attachNames(
    offers: BalanceTransferOffer[],
  ): Promise<BalanceTransferOffer[]> {
    const userIds = [
      ...new Set(offers.flatMap((o) => [o.transferrer_id, o.recipient_id])),
    ];
    if (userIds.length === 0) return offers;

    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, name")
      .in("user_id", userIds);

    const nameById = new Map((profiles || []).map((p) => [p.user_id, p.name || ""]));

    return offers.map((o) => ({
      ...o,
      transferrer_name: nameById.get(o.transferrer_id) || "",
      recipient_name: nameById.get(o.recipient_id) || "",
    }));
  }

  static async proposeOffer(input: {
    organizationId: string;
    recipientId: string;
    amount: number;
    paymentMode: "cash" | "bank_transfer";
    sourceBankAccountId?: string | null;
    note?: string | null;
    transferrerName: string;
    recipientName: string;
  }): Promise<string> {
    const { data, error } = await (supabase.rpc as any)("propose_balance_transfer_offer_v2", {
      p_organization_id: input.organizationId,
      p_recipient_id: input.recipientId,
      p_amount: input.amount,
      p_payment_mode: input.paymentMode,
      p_source_bank_account_id:
        input.paymentMode === "bank_transfer" ? input.sourceBankAccountId ?? null : null,
      p_note: input.note ?? null,
    });

    if (error) throw error;
    const offerId = data as string;

    await createNotification({
      userId: input.recipientId,
      organizationId: input.organizationId,
      type: "transfer_offer_received",
      title: "Transfer offer received",
      message: `${input.transferrerName} offered you ${formatINR(input.amount)}. Accept or reject with a reason.`,
    });

    return offerId;
  }

  static async acceptOffer(
    offerId: string,
    input: { transferrerId: string; recipientName: string; amount: number },
  ): Promise<void> {
    const { error } = await (supabase.rpc as any)("accept_balance_transfer_offer_v2", {
      p_offer_id: offerId,
    });
    if (error) throw error;

    await createNotification({
      userId: input.transferrerId,
      type: "transfer_offer_accepted",
      title: "Transfer offer accepted",
      message: `${input.recipientName} accepted your transfer offer of ${formatINR(input.amount)}.`,
    });
  }

  static async rejectOffer(
    offerId: string,
    reason: string,
    input: { transferrerId: string; recipientName: string; amount: number },
  ): Promise<void> {
    const validation = validateTransferRejectionReason(reason);
    if (!validation.valid) {
      throw new Error(validation.error || "Invalid rejection reason");
    }

    const { error } = await supabase.rpc("reject_balance_transfer_offer", {
      p_offer_id: offerId,
      p_reason: reason.trim(),
    });
    if (error) throw error;

    await createNotification({
      userId: input.transferrerId,
      type: "transfer_offer_rejected",
      title: "Transfer offer denied",
      message: `${input.recipientName} rejected your transfer offer of ${formatINR(input.amount)}. Reason: ${reason.trim()}`,
    });
  }

  static async cancelOffer(
    offerId: string,
    input: { recipientId: string; transferrerName: string; amount: number },
  ): Promise<void> {
    const { error } = await supabase.rpc("cancel_balance_transfer_offer", {
      p_offer_id: offerId,
    });
    if (error) throw error;

    await createNotification({
      userId: input.recipientId,
      type: "transfer_offer_cancelled",
      title: "Transfer offer cancelled",
      message: `${input.transferrerName} cancelled the transfer offer of ${formatINR(input.amount)}.`,
    });
  }

  static async fetchPendingForRecipient(userId: string): Promise<BalanceTransferOffer[]> {
    const { data, error } = await supabase
      .from("balance_transfer_offers")
      .select("*")
      .eq("recipient_id", userId)
      .eq("status", "pending")
      .order("proposed_at", { ascending: false });

    if (error) throw error;
    return this.attachNames((data || []) as BalanceTransferOffer[]);
  }

  static async countPendingForRecipient(userId: string): Promise<number> {
    const { count, error } = await supabase
      .from("balance_transfer_offers")
      .select("id", { count: "exact", head: true })
      .eq("recipient_id", userId)
      .eq("status", "pending");

    if (error) return 0;
    return count ?? 0;
  }

  static async fetchSentByTransferrer(userId: string): Promise<BalanceTransferOffer[]> {
    const { data, error } = await supabase
      .from("balance_transfer_offers")
      .select("*")
      .eq("transferrer_id", userId)
      .order("proposed_at", { ascending: false });

    if (error) throw error;
    return this.attachNames((data || []) as BalanceTransferOffer[]);
  }

  static async fetchHistoryForUser(userId: string): Promise<BalanceTransferOffer[]> {
    const { data, error } = await supabase
      .from("balance_transfer_offers")
      .select("*")
      .or(`recipient_id.eq.${userId},transferrer_id.eq.${userId}`)
      .neq("status", "pending")
      .order("responded_at", { ascending: false });

    if (error) throw error;
    return this.attachNames((data || []) as BalanceTransferOffer[]);
  }
}
