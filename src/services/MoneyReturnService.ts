import { supabase } from "@/integrations/supabase/client";
import { formatINR } from "@/lib/format";
import { createNotification } from "./NotificationService";
import { pickCurrentMembership } from "@/lib/currentMembership";

export interface MoneyReturnRequest {
  id: string;
  requester_id: string;
  cashier_id: string;
  amount: number;
  note?: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  approved_at?: string;
  rejected_at?: string;
  approved_by?: string;
  rejected_by?: string;
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}

export class MoneyReturnService {
  /**
   * Resolve the organization to create/evaluate a return request against.
   *
   * A user can hold several active organization_memberships rows (e.g. a
   * cashier who is also an employee of a second organization). The previous
   * implementation fetched a single arbitrary row via `.limit(1)` with no
   * ORDER BY -- Postgres does not guarantee which row that is. For a
   * multi-org user this could silently resolve a DIFFERENT organization than
   * the one the requester/cashier are actually operating in, which then
   * either rejects a legitimately-assigned cashier ("not active in your
   * organization") or stamps the created request with an organization_id
   * that the resolved cashier/requester isn't a member of -- making
   * approve_money_return_request_v2's own org-scoped role checks fail later.
   * Mirrors the `pickCurrentMembership` resolution already used by
   * AuthContext (src/lib/currentMembership.ts) for exactly this class of bug.
   */
  private static async getOrganizationIdForUser(
    userId: string,
    preferredOrganizationId?: string | null
  ): Promise<string | null> {
    const { data, error } = await supabase
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", userId)
      .eq("is_active", true);
    if (error) return null;
    return pickCurrentMembership(data ?? [], preferredOrganizationId)?.organization_id ?? null;
  }

  /**
   * Create a money return request (requires cashier approval)
   */
  static async createReturnRequest(
    requesterId: string,
    cashierId: string,
    amount: number,
    note?: string
  ): Promise<MoneyReturnRequest> {
    // First, verify the requester has sufficient balance
    const { data: requesterProfile, error: profileError } = await supabase
      .from("profiles")
      .select("balance, name, organization_id")
      .eq("user_id", requesterId)
      .single();

    if (profileError) throw profileError;

    const currentBalance = Number(requesterProfile?.balance ?? 0);
    if (amount > currentBalance) {
      throw new Error(`Insufficient balance. You only have ${formatINR(currentBalance)}`);
    }

    // Resolve organization for this return request. Some deployments enforce
    // money_return_requests.organization_id as NOT NULL. Prefer the
    // requester's profile organization_id (their "current" org) over an
    // arbitrary active membership row -- see getOrganizationIdForUser.
    const organizationId = await this.getOrganizationIdForUser(
      requesterId,
      (requesterProfile as any)?.organization_id ?? null
    );
    if (!organizationId) {
      throw new Error("Could not determine your organization. Please contact an administrator.");
    }

    // Ensure selected cashier/admin belongs to the same active organization.
    const { data: cashierMembership, error: cashierMembershipError } = await supabase
      .from("organization_memberships")
      .select("user_id")
      .eq("user_id", cashierId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .in("role", ["cashier", "admin"])
      .maybeSingle();

    if (cashierMembershipError) {
      throw cashierMembershipError;
    }
    if (!cashierMembership?.user_id) {
      throw new Error("Assigned cashier is not active in your organization.");
    }

    // Create the return request
    const { data: request, error: requestError } = await (supabase as any)
      .from("money_return_requests")
      .insert({
        requester_id: requesterId,
        cashier_id: cashierId,
        amount: amount,
        organization_id: organizationId,
        note: note?.trim() || null,
        status: "pending",
      })
      .select()
      .single();

    if (requestError) throw requestError;

    // Get requester name for notification
    const requesterName = requesterProfile?.name || "User";

    // Notify cashier about the return request
    await createNotification({
      userId: cashierId,
      type: "balance_added", // Reusing this type, or we can add a new type
      title: "Money Return Request",
      message: `${requesterName} wants to return ${formatINR(amount)} to you. Please approve or reject this request.`,
    });

    return request as MoneyReturnRequest;
  }

  /**
   * Approve a money return request (cashier action). Server-authoritative:
   * approve_money_return_request_v2 locks the request and both profile
   * rows, resolves the amount from the request (never the browser), and
   * writes the balance mutation, ledger, history, and money_assignments
   * consumption in one transaction. Insufficient balance at approval time
   * rejects the request server-side with zero balance mutation -- surfaced
   * here as a thrown Error so existing callers' catch/toast handling is
   * unchanged.
   */
  static async approveReturnRequest(
    requestId: string,
    cashierId: string
  ): Promise<void> {
    const { data, error } = await (supabase.rpc as any)("approve_money_return_request_v2", {
      p_request_id: requestId,
    });

    if (error) throw error;

    if (data?.rejected) {
      throw new Error("Requester has insufficient balance. Request has been rejected.");
    }

    const amount = Number(data?.amount ?? 0);

    // Notification is best-effort, after the mutation already committed --
    // the requester_id isn't part of the RPC's result payload, so re-read
    // the (now-approved) request row, which RLS still allows the cashier to
    // see since they are money_return_requests.cashier_id on it.
    const [{ data: request }, { data: cashierProfile }] = await Promise.all([
      supabase.from("money_return_requests").select("requester_id").eq("id", requestId).maybeSingle(),
      supabase.from("profiles").select("name").eq("user_id", cashierId).single(),
    ]);

    if (request?.requester_id) {
      const cashierName = cashierProfile?.name || "Cashier";
      await createNotification({
        userId: request.requester_id,
        type: "balance_added",
        title: "Money Return Approved",
        message: `Your return request of ${formatINR(amount)} has been approved by ${cashierName}. Amount deducted from your balance.`,
      });
    }
  }

  /**
   * Reject a money return request (cashier action)
   */
  static async rejectReturnRequest(
    requestId: string,
    cashierId: string,
    reason?: string
  ): Promise<void> {
    const { data: request, error: fetchError } = await supabase
      .from("money_return_requests")
      .select("*")
      .eq("id", requestId)
      .eq("cashier_id", cashierId)
      .eq("status", "pending")
      .single();

    if (fetchError) throw fetchError;
    if (!request) throw new Error("Return request not found or already processed");

    // Mark request as rejected
    const { error: updateError } = await supabase
      .from("money_return_requests")
      .update({
        status: "rejected",
        rejected_at: new Date().toISOString(),
        rejected_by: cashierId,
        rejection_reason: reason || null,
      })
      .eq("id", requestId);

    if (updateError) throw updateError;

    // Get cashier name for notification
    const { data: cashierProfile } = await supabase
      .from("profiles")
      .select("name")
      .eq("user_id", cashierId)
      .single();

    // Notify requester that request was rejected
    const cashierName = cashierProfile?.name || "Cashier";
    await createNotification({
      userId: request.requester_id,
      type: "expense_rejected", // Reusing this type
      title: "Money Return Rejected",
      message: `Your return request of ${formatINR(Number(request.amount))} has been rejected by ${cashierName}${reason ? `. Reason: ${reason}` : ''}`,
    });
  }

  /**
   * Get pending return requests for a cashier
   */
  static async getPendingRequests(cashierId: string): Promise<MoneyReturnRequest[]> {
    const { data, error } = await supabase
      .from("money_return_requests")
      .select("*")
      .eq("cashier_id", cashierId)
      .eq("status", "pending")
      .order("requested_at", { ascending: false });

    if (error) throw error;
    return (data || []) as MoneyReturnRequest[];
  }

  /**
   * Get return requests for a requester
   */
  static async getRequesterRequests(requesterId: string): Promise<MoneyReturnRequest[]> {
    const { data, error } = await supabase
      .from("money_return_requests")
      .select("*")
      .eq("requester_id", requesterId)
      .order("requested_at", { ascending: false });

    if (error) throw error;
    return (data || []) as MoneyReturnRequest[];
  }
}

