import { supabase } from "@/integrations/supabase/client";
import { formatINR } from "@/lib/format";
import { createNotification } from "./NotificationService";

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
  private static buildTransferHistoryNote(requestId: string, requestNote?: string | null): string {
    const cleanedNote = requestNote?.trim();
    if (!cleanedNote) {
      return `Money return request approved (${requestId})`;
    }
    return `Money return request approved (${requestId}): ${cleanedNote}`;
  }

  private static async getOrganizationIdForUser(userId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return data?.organization_id ?? null;
  }

  private static async getPrimaryRoleForUser(userId: string, organizationId: string): Promise<"employee" | "engineer" | "cashier" | "admin" | null> {
    const { data, error } = await supabase
      .from("organization_memberships")
      .select("role")
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .eq("is_active", true);

    if (error || !data || data.length === 0) return null;

    const roles = data.map((r) => r.role);
    if (roles.includes("admin")) return "admin";
    if (roles.includes("cashier")) return "cashier";
    if (roles.includes("engineer")) return "engineer";
    if (roles.includes("employee")) return "employee";
    return null;
  }

  private static async logApprovedReturnToTransferHistory(request: any, cashierId: string): Promise<void> {
    const amount = Number(request.amount);
    const approvedAt = request.approved_at || new Date().toISOString();
    const organizationId =
      request.organization_id ||
      (await this.getOrganizationIdForUser(cashierId));

    if (!organizationId || !amount || amount <= 0) return;

    const requesterRole = await this.getPrimaryRoleForUser(request.requester_id, organizationId);
    if (requesterRole !== "employee" && requesterRole !== "engineer") return;

    const transferType = requesterRole === "engineer" ? "engineer_to_cashier" : "employee_to_cashier";

    // Avoid duplicate insert when DB trigger already wrote the history row.
    const desiredNote = this.buildTransferHistoryNote(request.id, request.note);
    const { data: existing } = await supabase
      .from("cash_transfer_history")
      .select("id, notes")
      .eq("organization_id", organizationId)
      .eq("transferrer_id", request.requester_id)
      .eq("recipient_id", cashierId)
      .eq("transfer_type", transferType)
      .eq("amount", amount)
      .eq("transferred_at", approvedAt)
      .limit(1)
      .maybeSingle();

    if (existing?.id) {
      if ((existing.notes || "") !== desiredNote) {
        await supabase.from("cash_transfer_history").update({ notes: desiredNote }).eq("id", existing.id);
      }
      return;
    }

    const { error: historyError } = await supabase
      .from("cash_transfer_history")
      .insert({
        organization_id: organizationId,
        transferrer_id: request.requester_id,
        transferrer_role: requesterRole,
        recipient_id: cashierId,
        recipient_role: "cashier",
        amount,
        transfer_type: transferType,
        transferred_at: approvedAt,
        payment_mode: "cash",
        notes: desiredNote,
      });

    if (historyError) {
      console.error("Failed to log money return transfer history:", historyError);
    }
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
      .select("balance, name")
      .eq("user_id", requesterId)
      .single();

    if (profileError) throw profileError;

    const currentBalance = Number(requesterProfile?.balance ?? 0);
    if (amount > currentBalance) {
      throw new Error(`Insufficient balance. You only have ${formatINR(currentBalance)}`);
    }

    // Resolve organization for this return request. Some deployments enforce
    // money_return_requests.organization_id as NOT NULL.
    const organizationId = await this.getOrganizationIdForUser(requesterId);
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
   * Approve a money return request (cashier action)
   */
  static async approveReturnRequest(
    requestId: string,
    cashierId: string
  ): Promise<void> {
    // Get the request
    const { data: request, error: fetchError } = await supabase
      .from("money_return_requests")
      .select("*")
      .eq("id", requestId)
      .eq("cashier_id", cashierId)
      .eq("status", "pending")
      .single();

    if (fetchError) throw fetchError;
    if (!request) throw new Error("Return request not found or already processed");

    // Verify requester still has sufficient balance
    const { data: requesterProfile, error: requesterError } = await supabase
      .from("profiles")
      .select("balance, name")
      .eq("user_id", request.requester_id)
      .single();

    if (requesterError) throw requesterError;

    const requesterBalance = Number(requesterProfile?.balance ?? 0);
    const amount = Number(request.amount);

    if (amount > requesterBalance) {
      // Reject the request if insufficient balance
      await supabase
        .from("money_return_requests")
        .update({
          status: "rejected",
          rejected_at: new Date().toISOString(),
          rejected_by: cashierId,
          rejection_reason: "Insufficient balance at time of approval",
        })
        .eq("id", requestId);

      throw new Error("Requester has insufficient balance. Request has been rejected.");
    }

    // Get cashier's current balance
    const { data: cashierProfile, error: cashierError } = await supabase
      .from("profiles")
      .select("balance, name")
      .eq("user_id", cashierId)
      .single();

    if (cashierError) throw cashierError;

    // Start transaction: Deduct from requester and add to cashier
    const newRequesterBalance = requesterBalance - amount;
    const newCashierBalance = (Number(cashierProfile?.balance ?? 0)) + amount;

    // Update requester balance
    const { error: requesterUpdateError } = await supabase
      .from("profiles")
      .update({ balance: newRequesterBalance })
      .eq("user_id", request.requester_id);

    if (requesterUpdateError) throw requesterUpdateError;

    // Update cashier balance
    const { error: cashierUpdateError } = await supabase
      .from("profiles")
      .update({ balance: newCashierBalance })
      .eq("user_id", cashierId);

    if (cashierUpdateError) {
      // Rollback requester balance if cashier update fails
      await supabase
        .from("profiles")
        .update({ balance: requesterBalance })
        .eq("user_id", request.requester_id);
      throw cashierUpdateError;
    }

    // Mark request as approved
    const { error: updateError } = await supabase
      .from("money_return_requests")
      .update({
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: cashierId,
      })
      .eq("id", requestId);

    if (updateError) {
      // Rollback both balances if update fails
      await supabase
        .from("profiles")
        .update({ balance: requesterBalance })
        .eq("user_id", request.requester_id);
      await supabase
        .from("profiles")
        .update({ balance: Number(cashierProfile?.balance ?? 0) })
        .eq("user_id", cashierId);
      throw updateError;
    }

    await this.logApprovedReturnToTransferHistory(request, cashierId);

    // Mark money assignments as returned (FIFO)
    let remainingAmount = amount;
    const { data: assignments, error: assignmentsError } = await supabase
      .from("money_assignments")
      .select("id, amount")
      .eq("recipient_id", request.requester_id)
      .eq("cashier_id", cashierId)
      .eq("is_returned", false)
      .order("assigned_at", { ascending: true });

    if (!assignmentsError && assignments && assignments.length > 0) {
      for (const assignment of assignments) {
        if (remainingAmount <= 0) break;

        const assignmentAmount = Number(assignment.amount);
        if (assignmentAmount <= remainingAmount) {
          await supabase
            .from("money_assignments")
            .update({
              is_returned: true,
              returned_at: new Date().toISOString(),
              return_transaction_id: requestId,
            })
            .eq("id", assignment.id);
          remainingAmount -= assignmentAmount;
        }
      }
    }

    // Notify requester that request was approved
    const cashierName = cashierProfile?.name || "Cashier";
    await createNotification({
      userId: request.requester_id,
      type: "balance_added",
      title: "Money Return Approved",
      message: `Your return request of ${formatINR(amount)} has been approved by ${cashierName}. Amount deducted from your balance.`,
    });
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

