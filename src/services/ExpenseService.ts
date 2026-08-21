import { supabase } from "@/integrations/supabase/client";
import { Database } from "@/integrations/supabase/types";
import { formatINR } from "@/lib/format";
import {
  buildHierarchyFlags,
  canRoleActOnExpense,
  canRoleApprove,
  isAdminApprovableStatus,
  membershipRoleToTier,
  resolveInitialAssignment,
  resolveManagingEngineerId,
  resolveNextTierAfterVerify,
  type ApprovalTier,
  type HierarchyFeatureFlags,
} from "@/lib/approvalHierarchy";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { parseApproveExpenseV2Result } from "@/lib/approvalResult";
import {
  fetchFirstAdminUserId,
  fetchTeamForUser,
} from "@/services/TeamHierarchyService";
import {
  computeManagerQueueReady,
  fetchExecutiveHandoffExpenseIds,
  isUserTeamManagerForExpense,
} from "@/lib/managerActionableExpenses";
import { fetchReviewerCorrectedExpenseIds } from "@/lib/supabaseInQuery";
import type { BranchFieldValueMap } from "@/lib/conditionalFormFieldTypes";
import type { BatchExpenseAttachmentMode } from "@/lib/expenseBatchConstants";
import type { BatchReviewRole } from "@/lib/batchExpenseReview";
import {
  copyAttachmentsFromExpense,
  enforceMaxAttachmentSize,
  moveTempFilesToExpense,
  type TempUploadMeta,
} from "@/lib/expenseBatchAttachments";
import {
  batchLineTotal,
  formatExpenseDateString,
} from "@/lib/expenseBatchValidation";
import { canOwnerEditExpenseStatus } from "@/lib/expenseEditRules";
import {
  buildExpenseCustomFieldPayload,
  type ExpenseCustomFieldValuePayload,
} from "@/lib/expenseFormFieldPayload";
import { 
  notifyExpenseVerified, 
  notifyExpenseApproved, 
  notifyExpenseSubmitted,
  notifyExpenseSubmissionProgress,
  notifyExpenseForwardedForReview,
  notifyEngineerExpenseApproved,
  notifyExpenseRejected,
  notifyExpenseVerifiedToAdmin,
  notifyExpenseCorrected,
} from "./NotificationService";

// Helper function to get user's organization_id
async function getUserOrganizationId(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  
  if (error || !data) return null;
  return data.organization_id;
}

/**
 * Prefer over `.single()` on `profiles`: missing or duplicate rows cause PostgREST 406
 * "Cannot coerce the result to a single JSON object".
 */
async function resolveProfileDisplayName(userId: string): Promise<string> {
  const { data, error } = await selectFirstProfileRow(userId, "name");
  if (error) return "Unknown user";
  const name = (data?.name as string | undefined)?.trim();
  return name || "Unknown user";
}

async function selectFirstProfileRow(
  userId: string,
  columns: string
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  const { data, error } = await supabase
    .from("profiles")
    .select(columns)
    .eq("user_id", userId)
    .limit(1);
  if (error) return { data: null, error };
  const row = data && data.length > 0 ? (data[0] as Record<string, unknown>) : null;
  return { data: row, error: null };
}

type ExpenseReviewHead = {
  id?: string;
  organization_id?: string;
  status: string;
  approval_tier: ApprovalTier | null;
  assigned_reviewer_id: string | null;
  assigned_engineer_id: string | null;
  user_id?: string;
  title?: string;
  total_amount?: number;
};

function throwRpcError(error: { message?: string } | null): void {
  if (!error) return;
  throw new Error(error.message?.trim() || "Request failed");
}

async function selectFirstOrgSettingsRow(
  organizationId: string,
  columns: string
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  const { data, error } = await supabase
    .from("organization_settings")
    .select(columns)
    .eq("organization_id", organizationId)
    .limit(1);
  if (error) return { data: null, error };
  const row = data && data.length > 0 ? (data[0] as Record<string, unknown>) : null;
  return { data: row, error: null };
}

type Expense = Database["public"]["Tables"]["expenses"]["Row"];
type ExpenseInsert = Database["public"]["Tables"]["expenses"]["Insert"];
type ExpenseUpdate = Database["public"]["Tables"]["expenses"]["Update"];
type LineItem = Database["public"]["Tables"]["expense_line_items"]["Row"];
type LineItemInsert = Database["public"]["Tables"]["expense_line_items"]["Insert"];

export interface ExpenseWithLineItems extends Expense {
  expense_line_items: LineItem[];
}

export interface CreateExpenseData {
  title: string;
  destination: string;
  trip_start: string;
  trip_end: string;
  purpose?: string;
  amount: number;
  category: string;
}

export interface UpdateExpenseData {
  title?: string;
  destination?: string;
  trip_start?: string;
  trip_end?: string;
  purpose?: string;
  status?: "submitted" | "verified" | "approved";
  admin_comment?: string;
  assigned_engineer_id?: string;
  amount?: number;
  category?: string;
}

export type BatchSubmitLineInput = {
  title: string;
  amount: number;
  category: string;
  destination: string;
  purpose?: string;
  tempReceiptFilenames?: string[];
  formFieldValues?: Record<string, string>;
  branchValues?: Record<string, string>;
  /** Precomputed visible branch field ids (from conditional form engine on client). */
  visibleBranchIds?: string[];
};

export type BatchSubmitSharedInput = {
  expenseDate: Date;
  sharedDestination?: string;
  label?: string;
};

export type BatchSubmitLineResult = {
  lineIndex: number;
  ok: boolean;
  expenseId?: string;
  transactionNumber?: string | null;
  error?: string;
};

export type BatchSubmitResult = {
  batchId: string;
  results: BatchSubmitLineResult[];
  successCount: number;
  failureCount: number;
};

/** Per-child transaction detail returned by a successful batch verify. */
export type BatchVerifyTransaction = {
  transactionNumber: string | null;
  employeeId: string | null;
  statusBefore: string;
  statusAfter: string;
  tierBefore: string | null;
  tierAfter: string | null;
};

/** Per-child blocker detail returned when a batch verify cannot proceed. */
export type BatchVerifyBlocker = {
  expenseId: string;
  transactionNumber: string | null;
  employeeId: string | null;
  status: string;
  approvalTier: string | null;
  reason: string;
};

/** Result of `ExpenseService.verifyBatchAtomic` -- DOC-098. */
export type BatchVerifyResult =
  | { ok: true; batchId: string; verifiedCount: number; transactions: BatchVerifyTransaction[] }
  | { ok: false; batchId: string; code: "batch_not_found" }
  | { ok: false; batchId: string; code: "batch_verification_blocked"; blockers: BatchVerifyBlocker[] };

/** Payload for `apply_expense_correction` RPC (partial updates). */
export interface ExpenseCorrectionUpdates {
  title?: string;
  destination?: string;
  trip_start?: string;
  trip_end?: string;
  purpose?: string | null;
  category?: string | null;
  total_amount?: number;
  admin_comment?: string | null;
}

type ReviewRpcResult = {
  ok?: boolean;
  expense?: Expense;
};

/** Prefer expense row returned by review RPCs (reviewer may lose SELECT after reassignment). */
function expenseFromReviewRpc(rpcResult: unknown, fallback: Expense): Expense {
  const row = (rpcResult as ReviewRpcResult | null)?.expense;
  if (row && typeof row === "object" && "id" in row) {
    return row;
  }
  return fallback;
}

export class ExpenseService {
  /**
   * Create a new expense with line items
   * Automatically computes total amount from line items
   */
  static async createExpense(
    userId: string,
    data: CreateExpenseData
  ): Promise<ExpenseWithLineItems> {
    // Get user's organization_id
    const organizationId = await getUserOrganizationId(userId);
    if (!organizationId) {
      throw new Error("User is not associated with an organization");
    }

    // No line items in creation flow; use provided amount as total
    const totalAmount = Number(data.amount || 0);

    // Start transaction
    const { data: expense, error: expenseError } = await supabase
      .from("expenses")
      .insert({
        user_id: userId,
        organization_id: organizationId,
        title: data.title,
        destination: data.destination,
        trip_start: data.trip_start,
        trip_end: data.trip_end,
        purpose: data.purpose,
        category: data.category,
        total_amount: totalAmount,
        // Create first, then submitExpense() will move it to "submitted" and write the submitted audit log.
        // This avoids UI showing "Submitted" while audit logs/attachments are still being finalized.
        status: "draft",
      })
      .select()
      .maybeSingle();

    if (expenseError) {
      console.error("Expense creation error:", expenseError);
      throw new Error(`Failed to create expense: ${expenseError.message || 'Unknown error'}`);
    }
    if (!expense) {
      throw new Error("Failed to create expense: no row returned");
    }

    // No line items to insert
    const lineItems: LineItem[] = [];

    // Log the action
    await this.logAction(expense.id, userId, organizationId, "expense_created", "Expense created");

    return {
      ...expense,
      expense_line_items: lineItems,
    };
  }

  /**
   * Update an existing expense
   * Recalculates total amount if line items are updated
   */
  static async updateExpense(
    expenseId: string,
    userId: string,
    data: UpdateExpenseData
  ): Promise<ExpenseWithLineItems> {
    // Get user's organization_id
    const organizationId = await getUserOrganizationId(userId);
    if (!organizationId) {
      throw new Error("User is not associated with an organization");
    }

    // Check if user can edit this expense
    const canEdit = await this.canUserEditExpense(expenseId, userId, organizationId);
    console.log('🔍 [ExpenseService] Can edit check:', {
      expenseId,
      userId,
      organizationId,
      canEdit
    });
    if (!canEdit) {
      // Get expense details for better error message
      const { data: expenseCheck } = await supabase
        .from("expenses")
        .select("user_id, status, organization_id")
        .eq("id", expenseId)
        .maybeSingle();
      console.error('❌ [ExpenseService] Cannot edit expense:', {
        expenseUserId: expenseCheck?.user_id,
        expenseStatus: expenseCheck?.status,
        expenseOrgId: expenseCheck?.organization_id,
        currentUserId: userId,
        currentOrgId: organizationId
      });
      throw new Error("You don't have permission to edit this expense");
    }

    // Get current expense (filtered by organization)
    const { data: currentExpense, error: fetchError } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!currentExpense) throw new Error("Expense not found or you don't have access");

    // Block owner edits after approval (batch lines follow the same rule per expense).
    if (
      !data.status &&
      (currentExpense.status === "approved" || currentExpense.status === "paid")
    ) {
      throw new Error("Approved expenses cannot be edited.");
    }
    if (
      !data.status &&
      currentExpense.status !== "submitted" &&
      currentExpense.status !== "rejected" &&
      currentExpense.status !== "verified" &&
      currentExpense.status !== "draft" &&
      currentExpense.status !== "under_review"
    ) {
      throw new Error("This expense cannot be edited in its current status.");
    }

    const totalAmount = typeof data.amount === 'number' ? data.amount : currentExpense.total_amount;

    // Update expense - exclude 'amount' from spread since expenses table uses 'total_amount'
    const { amount, ...dataWithoutAmount } = data;
    const updateData: ExpenseUpdate = {
      ...dataWithoutAmount,
      total_amount: totalAmount,
      updated_at: new Date().toISOString(),
    };

    const { data: updatedExpense, error: updateError } = await supabase
      .from("expenses")
      .update(updateData)
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updatedExpense) throw new Error("Failed to update expense (no row returned)");

    if (currentExpense.batch_id) {
      await this.syncExpenseBatchAggregates(currentExpense.batch_id, organizationId);
    }

    // No line item updates; fetch none
    const lineItems: LineItem[] = [];

    // Log the action
    const action = data.status ? `status_changed_to_${data.status}` : "expense_updated";
    await this.logAction(expenseId, userId, organizationId, action, data.admin_comment);

    return {
      ...updatedExpense,
      expense_line_items: lineItems,
    };
  }

  /**
   * Recompute expense_batches.line_count and total_amount from child expenses (after line edits/deletes).
   */
  static async syncExpenseBatchAggregates(
    batchId: string,
    organizationId: string,
  ): Promise<void> {
    const { data: lines, error: linesError } = await supabase
      .from("expenses")
      .select("total_amount")
      .eq("batch_id", batchId)
      .eq("organization_id", organizationId);

    if (linesError) {
      console.warn("syncExpenseBatchAggregates:", linesError.message);
      return;
    }

    const line_count = lines?.length ?? 0;
    const total_amount = (lines ?? []).reduce(
      (sum, row) => sum + Number(row.total_amount || 0),
      0,
    );

    const { error: batchError } = await supabase
      .from("expense_batches")
      .update({ line_count, total_amount })
      .eq("id", batchId)
      .eq("organization_id", organizationId);

    if (batchError) {
      console.warn("syncExpenseBatchAggregates:", batchError.message);
    }
  }

  /**
   * Manager (assigned engineer) or admin corrects another user's expense.
   * Requires org feature `allow_manager_admin_expense_corrections` and DB RPC.
   */
  static async applyExpenseCorrectionByReviewer(
    expenseId: string,
    editorUserId: string,
    updates: ExpenseCorrectionUpdates,
    reason?: string | null,
    customFieldValues?: Record<string, string>,
    branchFieldValues?: Record<string, string>,
    visibleBranchIds?: Set<string>,
  ): Promise<void> {
    const organizationId = await getUserOrganizationId(editorUserId);
    if (!organizationId) {
      throw new Error("User is not associated with an organization");
    }

    const payload: Record<string, unknown> = {};
    if (updates.title !== undefined) payload.title = updates.title;
    if (updates.destination !== undefined) payload.destination = updates.destination;
    if (updates.trip_start !== undefined) payload.trip_start = updates.trip_start;
    if (updates.trip_end !== undefined) payload.trip_end = updates.trip_end;
    if (updates.purpose !== undefined) payload.purpose = updates.purpose;
    if (updates.category !== undefined) payload.category = updates.category;
    if (updates.total_amount !== undefined) payload.total_amount = updates.total_amount;
    if (updates.admin_comment !== undefined) payload.admin_comment = updates.admin_comment;

    if (Object.keys(payload).length === 0) {
      throw new Error("No changes to apply");
    }

    const { error } = await supabase.rpc("apply_expense_correction", {
      p_expense_id: expenseId,
      p_updates: payload,
      p_reason: reason ?? null,
    });

    if (error) {
      const msg = error.message || "";
      if (msg.includes("apply_expense_correction") || msg.includes("schema cache")) {
        throw new Error(
          "Expense correction is not set up on this database. Run migration supabase/migrations/20260513140000_expense_corrections_edited_status.sql, then Supabase Dashboard → Settings → API → Reload schema.",
        );
      }
      throw new Error(msg || "Failed to apply expense correction");
    }

    await this.logAction(
      expenseId,
      editorUserId,
      organizationId,
      "expense_corrected_by_reviewer",
      reason?.trim() || "Expense corrected by manager or admin",
    );

    const [expenseRow] = await Promise.all([
      supabase
        .from("expenses")
        .select("title, user_id")
        .eq("id", expenseId)
        .eq("organization_id", organizationId)
        .maybeSingle()
        .then((r) => r.data),
      customFieldValues !== undefined || branchFieldValues !== undefined
        ? this.replaceExpenseFormFieldValuesByReviewer(
            expenseId,
            organizationId,
            buildExpenseCustomFieldPayload({
              templateValues: customFieldValues,
              branchValues: branchFieldValues,
              visibleBranchIds,
            }),
          )
        : Promise.resolve(),
    ]);

    if (expenseRow) {
      const editorName = await resolveProfileDisplayName(editorUserId);
      void notifyExpenseCorrected(
        expenseId,
        String(expenseRow.title ?? "Expense"),
        String(expenseRow.user_id),
        editorName,
        reason ?? null,
      ).catch((e) => console.error("notifyExpenseCorrected failed:", e));
    }
  }

  /**
   * Atomically applies a singular expense correction — base fields and custom
   * field patch in a single DB transaction via apply_singular_expense_correction.
   *
   * Replaces the non-atomic pattern of calling applyExpenseCorrectionByReviewer
   * (which called apply_expense_correction then replace_expense_form_field_values_by_reviewer
   * in separate round-trips). Use this method for all singular corrections.
   */
  static async applySingularExpenseCorrection(
    expenseId: string,
    editorUserId: string,
    updates: ExpenseCorrectionUpdates,
    reason?: string | null,
    patch?: import("@/lib/buildCorrectionCustomFieldPatch").PatchItem[],
  ): Promise<void> {
    const organizationId = await getUserOrganizationId(editorUserId);
    if (!organizationId) {
      throw new Error("User is not associated with an organization");
    }

    const basePayload: Record<string, unknown> = {};
    if (updates.title !== undefined) basePayload.title = updates.title;
    if (updates.destination !== undefined) basePayload.destination = updates.destination;
    if (updates.trip_start !== undefined) basePayload.trip_start = updates.trip_start;
    if (updates.trip_end !== undefined) basePayload.trip_end = updates.trip_end;
    if (updates.purpose !== undefined) basePayload.purpose = updates.purpose;
    if (updates.category !== undefined) basePayload.category = updates.category;
    if (updates.total_amount !== undefined) basePayload.total_amount = updates.total_amount;
    if (updates.admin_comment !== undefined) basePayload.admin_comment = updates.admin_comment;

    if (Object.keys(basePayload).length === 0 && (!patch || patch.length === 0)) {
      throw new Error("No changes to apply");
    }

    const { error } = await supabase.rpc("apply_singular_expense_correction", {
      p_expense_id: expenseId,
      p_organization_id: organizationId,
      p_updates: basePayload,
      p_reason: reason ?? null,
      p_patch: patch ?? [],
    });

    if (error) {
      const msg = error.message || "";
      if (msg.includes("apply_singular_expense_correction") || msg.includes("schema cache")) {
        throw new Error(
          "Singular correction RPC not found. Run migration supabase/migrations/290707_2000_singular_correction_safety.sql, then reload the Supabase schema cache.",
        );
      }
      throw new Error(msg || "Failed to apply expense correction");
    }

    await this.logAction(
      expenseId,
      editorUserId,
      organizationId,
      "expense_corrected_by_reviewer",
      reason?.trim() || "Expense corrected by manager or admin",
    );

    const expenseRow = await supabase
      .from("expenses")
      .select("title, user_id")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle()
      .then((r) => r.data);

    if (expenseRow) {
      const editorName = await resolveProfileDisplayName(editorUserId);
      void notifyExpenseCorrected(
        expenseId,
        String(expenseRow.title ?? "Expense"),
        String(expenseRow.user_id),
        editorName,
        reason ?? null,
      ).catch((e) => console.error("notifyExpenseCorrected failed:", e));
    }
  }

  static async listExpenseCorrectionLogs(
    expenseId: string,
    userId: string,
  ): Promise<
    {
      id: string;
      created_at: string;
      edited_by: string;
      reason: string | null;
      before_json: unknown;
      after_json: unknown;
    }[]
  > {
    const organizationId = await getUserOrganizationId(userId);
    if (!organizationId) return [];

    const { data, error } = await supabase
      .from("expense_correction_logs")
      .select("id, created_at, edited_by, reason, before_json, after_json")
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("listExpenseCorrectionLogs:", error.message);
      return [];
    }
    return (data ?? []) as {
      id: string;
      created_at: string;
      edited_by: string;
      reason: string | null;
      before_json: unknown;
      after_json: unknown;
    }[];
  }

  /**
   * Expense IDs that have at least one reviewer correction log (for list/detail transparency).
   * When `organizationId` is set, results are scoped to that org; when omitted, RLS alone applies (e.g. employee listing their expenses).
   */
  static async getExpenseIdsWithReviewerCorrections(
    expenseIds: string[],
    organizationId: string | null,
  ): Promise<Set<string>> {
    return fetchReviewerCorrectedExpenseIds(supabase, expenseIds, organizationId);
  }

  static async isOrganizationFeatureEnabled(
    organizationId: string,
    featureKey: string,
  ): Promise<boolean> {
    const { data, error } = await supabase
      .from("organization_features")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("feature_key", featureKey)
      .maybeSingle();
    if (error) {
      console.warn("isOrganizationFeatureEnabled:", error.message);
      return false;
    }
    return data?.enabled === true;
  }

  static async getHierarchyFeatureFlags(
    organizationId: string,
  ): Promise<HierarchyFeatureFlags> {
    const keys = [
      ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
      ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader,
      ORGANIZATION_FEATURE_KEYS.hierarchy_executive,
    ];
    const { data, error } = await supabase
      .from("organization_features")
      .select("feature_key, enabled")
      .eq("organization_id", organizationId)
      .in("feature_key", keys);
    if (error) {
      console.warn("getHierarchyFeatureFlags:", error.message);
      return buildHierarchyFlags({});
    }
    const map: Record<string, boolean> = {};
    for (const row of data ?? []) {
      map[row.feature_key] = row.enabled === true;
    }
    return buildHierarchyFlags(map);
  }

  private static async fetchMembershipRole(
    organizationId: string,
    userId: string,
  ): Promise<string | null> {
    const { data } = await supabase
      .from("organization_memberships")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();
    return (data?.role as string | undefined) ?? null;
  }

  private static async loadHierarchyContext(
    organizationId: string,
    submitterUserId: string,
  ) {
    const [flags, teamsEnabled] = await Promise.all([
      this.getHierarchyFeatureFlags(organizationId),
      this.isOrganizationFeatureEnabled(organizationId, ORGANIZATION_FEATURE_KEYS.teams_enabled),
    ]);
    const [team, fallbackAdminUserId] = await Promise.all([
      flags.approval_hierarchy && teamsEnabled
        ? fetchTeamForUser(organizationId, submitterUserId)
        : Promise.resolve(null),
      flags.approval_hierarchy
        ? fetchFirstAdminUserId(organizationId)
        : Promise.resolve(null),
    ]);
    return { flags, team, fallbackAdminUserId };
  }

  /**
   * Advance expense to next hierarchy tier after team leader / executive verification.
   */
  private static async fetchExpenseReviewHead(
    expenseId: string,
    organizationId: string,
  ): Promise<ExpenseReviewHead | null> {
    const { data: rpcHead, error: rpcErr } = await supabase.rpc("get_expense_review_head", {
      p_expense_id: expenseId,
    });

    if (!rpcErr && rpcHead && typeof rpcHead === "object") {
      const row = rpcHead as Record<string, unknown>;
      if (row.organization_id === organizationId) {
        return {
          status: String(row.status ?? ""),
          approval_tier: (row.approval_tier as ApprovalTier | null) ?? null,
          assigned_reviewer_id: (row.assigned_reviewer_id as string | null) ?? null,
          assigned_engineer_id: (row.assigned_engineer_id as string | null) ?? null,
          user_id: row.user_id as string | undefined,
          title: row.title as string | undefined,
          total_amount: row.total_amount as number | undefined,
        };
      }
    }

    const { data: expense, error: fetchErr } = await supabase
      .from("expenses")
      .select(
        "id, user_id, title, status, approval_tier, assigned_reviewer_id, assigned_engineer_id, organization_id",
      )
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (fetchErr || !expense) return null;

    return {
      status: expense.status,
      approval_tier: (expense.approval_tier as ApprovalTier | null) ?? null,
      assigned_reviewer_id: expense.assigned_reviewer_id,
      assigned_engineer_id: expense.assigned_engineer_id,
      user_id: expense.user_id,
      title: expense.title,
      total_amount: expense.total_amount as number | undefined,
    };
  }

  static async advanceExpenseTier(
    expenseId: string,
    reviewerId: string,
    comment?: string,
    knownReviewerRole?: string | null,
  ): Promise<Expense> {
    const organizationId = await getUserOrganizationId(reviewerId);
    if (!organizationId) {
      throw new Error("Reviewer is not associated with an organization");
    }

    const flags = await this.getHierarchyFeatureFlags(organizationId);
    const reviewerRole =
      knownReviewerRole ?? (await this.fetchMembershipRole(organizationId, reviewerId));
    const isHierarchyReviewer =
      reviewerRole === "team_leader" || reviewerRole === "executive";

    if (!flags.approval_hierarchy && !isHierarchyReviewer) {
      throw new Error("Approval hierarchy is not enabled for this organization");
    }

    const head = await this.fetchExpenseReviewHead(expenseId, organizationId);
    if (!head?.user_id) throw new Error("Expense not found");

    const expense = {
      id: expenseId,
      user_id: head.user_id,
      title: head.title,
      status: head.status,
      approval_tier: head.approval_tier,
      assigned_reviewer_id: head.assigned_reviewer_id,
      assigned_engineer_id: head.assigned_engineer_id,
    };

    const role = reviewerRole ?? "";

    const { data: profileRow } = await selectFirstProfileRow(
      expense.user_id,
      "reporting_engineer_id",
    );
    const reportingEngineerId =
      (profileRow?.reporting_engineer_id as string | null | undefined) ?? null;

    const isAssignedBySnapshot =
      expense.assigned_reviewer_id === reviewerId ||
      expense.assigned_engineer_id === reviewerId;

    // Current-supervisor fallback: assigned_reviewer_id/assigned_engineer_id
    // are snapshotted at submission/last-tier-advance time and go stale when
    // an admin later reassigns the employee's immediate supervisor. A still-
    // pending expense (never verified at any hierarchy tier) follows the
    // CURRENT reporting_engineer_id instead, mirroring the server-side
    // fallback in expense_hierarchy_reviewer_can_act — the previous
    // supervisor loses this authority the moment they stop being the
    // employee's current supervisor.
    const isCurrentSupervisorFallback =
      !isAssignedBySnapshot &&
      isHierarchyReviewer &&
      reviewerId !== expense.user_id &&
      reportingEngineerId === reviewerId &&
      ["submitted", "edited", "under_review"].includes(expense.status);

    const isAssigned = isAssignedBySnapshot || isCurrentSupervisorFallback;

    if (!isAssigned) {
      throw new Error("You are not assigned to verify this expense");
    }

    // Re-verify the caller's role fresh, right before it decides which
    // hierarchy tier this verification counts as. `role` above may be a
    // caller-supplied `knownReviewerRole` (e.g. mirrored from a client-side
    // auth/session cache) rather than a value read from the database at this
    // moment — trusting a stale role here is exactly how this tier could end
    // up disagreeing with what review_advance_expense_hierarchy_tier's own
    // fresh, authoritative role check decides. Only re-fetches when a role
    // was actually supplied by the caller; otherwise `role` above already
    // came from a fresh fetchMembershipRole call moments ago.
    const currentRole = knownReviewerRole
      ? await this.fetchMembershipRole(organizationId, reviewerId)
      : role;

    // Which tier this verification counts as is ALWAYS the caller's own
    // CURRENT role (team_leader/executive — advanceExpenseTier is only ever
    // reached for those two roles), never the expense's snapshotted
    // approval_tier: review_advance_expense_hierarchy_tier independently
    // derives v_is_tl/v_is_exec from the caller's live organization_memberships
    // row and decides the resulting status from THAT alone, ignoring the
    // approval_tier the client proposes. Deriving `tier` from a stale
    // approval_tier snapshot (e.g. still 'team_leader' because that's what
    // it was when this reviewer was assigned, even though their own role has
    // since been changed to executive in User Management) sends the server a
    // next-tier request computed for the WRONG current tier — the server's
    // returned status then correctly reflects their real role, disagreeing
    // with the client's prediction, and worse: the approval_tier the client
    // asked the server to persist is also wrong for the tier the server
    // actually processed. Using the caller's current role directly for every
    // branch (matching what the current-supervisor-fallback branch already
    // did) keeps client and server in agreement by construction.
    let tier: "team_leader" | "executive" | null = null;
    const expenseTier = expense.approval_tier as ApprovalTier | null;
    if (
      isCurrentSupervisorFallback ||
      expenseTier === "team_leader" ||
      expenseTier === "executive" ||
      expenseTier === null
    ) {
      tier = currentRole === "team_leader" ? "team_leader" : "executive";
    } else if (
      expenseTier === "engineer" &&
      expense.assigned_engineer_id === reviewerId
    ) {
      // Existing dual-assignment edge case: a team_leader/executive who is
      // ALSO the expense's assigned engineer acts at their own tier, not the
      // engineer tier.
      tier = currentRole === "team_leader" ? "team_leader" : "executive";
    }

    if (!tier) {
      throw new Error("This expense is not awaiting hierarchy tier verification");
    }

    const allowedStatuses =
      tier === "executive"
        ? ["submitted", "edited", "level_1_verified"]
        : ["submitted", "edited"];
    if (!allowedStatuses.includes(expense.status)) {
      throw new Error("Only submitted or adjusted expenses can be verified at this tier");
    }

    const reportingSupervisorRole = reportingEngineerId
      ? await this.fetchMembershipRole(organizationId, reportingEngineerId)
      : null;

    let verifierSupervisorId: string | null = null;
    let verifierSupervisorRole: string | null = null;
    if (tier === "team_leader") {
      const { data: verifierProfile } = await selectFirstProfileRow(
        reviewerId,
        "reporting_engineer_id",
      );
      verifierSupervisorId =
        (verifierProfile?.reporting_engineer_id as string | null | undefined) ?? null;
      if (verifierSupervisorId) {
        verifierSupervisorRole = await this.fetchMembershipRole(
          organizationId,
          verifierSupervisorId,
        );
      }
    }

    let supervisorReportingEngineerId: string | null = null;
    let supervisorReportingRole: string | null = null;
    if (reportingEngineerId && reportingSupervisorRole === "team_leader") {
      const { data: tlProfile } = await selectFirstProfileRow(
        reportingEngineerId,
        "reporting_engineer_id",
      );
      supervisorReportingEngineerId =
        (tlProfile?.reporting_engineer_id as string | null | undefined) ?? null;
      if (supervisorReportingEngineerId) {
        supervisorReportingRole = await this.fetchMembershipRole(
          organizationId,
          supervisorReportingEngineerId,
        );
      }
    }

    const team = await fetchTeamForUser(organizationId, expense.user_id);
    const fallbackAdminUserId = await fetchFirstAdminUserId(organizationId);
    const hierarchyInput = {
      flags,
      team,
      reportingEngineerId,
      reportingSupervisorRole,
      fallbackAdminUserId,
      verifierSupervisorId,
      verifierSupervisorRole,
      supervisorReportingEngineerId,
      supervisorReportingRole,
    };
    const managingEngineerId =
      resolveManagingEngineerId(hierarchyInput) ?? team?.manager_user_id ?? null;

    const next = resolveNextTierAfterVerify(tier, {
      ...hierarchyInput,
      managingEngineerId,
    });

    const rpcManagingEngineerId =
      next.approval_tier === "engineer"
        ? next.assigned_engineer_id
        : managingEngineerId ?? next.assigned_engineer_id;

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "review_advance_expense_hierarchy_tier",
      {
        p_expense_id: expenseId,
        p_next_approval_tier: next.approval_tier,
        p_next_assigned_reviewer_id: next.assigned_reviewer_id,
        p_next_assigned_engineer_id: rpcManagingEngineerId,
        p_comment: comment ?? null,
      },
    );

    throwRpcError(rpcError);

    const statusAfterTierVerify =
      tier === "team_leader"
        ? "level_1_verified"
        : tier === "executive"
          ? "level_2_verified"
          : "submitted";

    const tierAdvanceFallback = {
      ...(expense as Expense),
      organization_id: organizationId,
      approval_tier: next.approval_tier,
      assigned_reviewer_id: next.assigned_reviewer_id,
      assigned_engineer_id: next.assigned_engineer_id,
      status: statusAfterTierVerify,
    } as Expense;

    const updatedExpense = expenseFromReviewRpc(rpcResult, tierAdvanceFallback);

    // The server is the sole authority on which tier this verification
    // counted as (see the tier-derivation comment above) — it is not asked
    // to match the client's `tier` guess. What IS still checked, as a
    // meaningful invariant rather than a removed one: the expense must have
    // genuinely advanced to a real hierarchy-verified status, distinct from
    // its pre-verify status. That is exactly the failure mode the old
    // "run migration 20260524260000" message was written to catch (a Verify
    // call that silently no-ops); it does not fire merely because the server
    // determined a different, equally valid tier than the client expected.
    const validAdvancedStatuses = ["level_1_verified", "level_2_verified"];
    if (
      !validAdvancedStatuses.includes(updatedExpense.status) ||
      updatedExpense.status === expense.status
    ) {
      throw new Error(
        `Verify did not advance this expense's review status (database returned "${updatedExpense.status}", ` +
          `was "${expense.status}"). Your organization role may no longer match a hierarchy tier this expense ` +
          "can be verified at — refresh the page and try again, or contact an admin if this keeps happening.",
      );
    }

    // The tier the SERVER actually recorded this verification as — derived
    // from its returned status, which is authoritative — used for the audit
    // comment so history stays truthful even in the rare case this differs
    // from the client's `tier` guess above (e.g. a just-changed role that
    // this session's cached role hasn't picked up yet).
    const actualVerifiedTier: "team_leader" | "executive" =
      updatedExpense.status === "level_1_verified" ? "team_leader" : "executive";

    const reviewerName = await resolveProfileDisplayName(reviewerId);
    await this.logAction(
      expenseId,
      reviewerId,
      organizationId,
      "tier_advanced",
      comment ?? `Verified at ${actualVerifiedTier} by ${reviewerName}; advanced to ${next.approval_tier ?? "admin"}`,
    );

    if (expense.title) {
      void notifyExpenseVerified(
        expenseId,
        expense.title,
        expense.user_id,
        reviewerName,
      ).catch((e) => console.error("advanceExpenseTier employee verify notify:", e));
    }

    if (next.assigned_reviewer_id && expense.title) {
      const { data: employeeProfile } = await selectFirstProfileRow(expense.user_id, "name");
      const employeeName = (employeeProfile?.name as string | undefined) || "Employee";
      const reviewerLabel =
        next.approval_tier === "team_leader"
          ? "Team Leader"
          : next.approval_tier === "executive"
            ? "Executive"
            : next.approval_tier === "engineer"
              ? "Manager"
              : "Admin";
      void notifyExpenseForwardedForReview(
        expenseId,
        expense.title,
        employeeName,
        reviewerLabel,
        next.assigned_reviewer_id,
      ).catch((e) => console.error("advanceExpenseTier notify:", e));
    } else if (next.approval_tier === "admin") {
      const { data: adminMemberships } = await supabase
        .from("organization_memberships")
        .select("user_id")
        .eq("organization_id", organizationId)
        .eq("role", "admin")
        .eq("is_active", true);
      const adminUserIds = adminMemberships?.map((m) => m.user_id) || [];
      if (adminUserIds.length > 0 && expense.title) {
        const { data: employeeProfile } = await selectFirstProfileRow(expense.user_id, "name");
        const employeeName = (employeeProfile?.name as string | undefined) || "Employee";
        void notifyExpenseForwardedForReview(
          expenseId,
          expense.title,
          employeeName,
          "Admin",
          null,
          adminUserIds,
        ).catch((e) => console.error("advanceExpenseTier admin notify:", e));
      }
    }

    return updatedExpense as Expense;
  }

  /**
   * Atomically verify every eligible child of ONE batch at the hierarchy tier
   * (team_leader/executive), via the server-authoritative
   * review_verify_batch_atomic_v1 RPC (DOC-098). The RPC resolves batch
   * membership itself -- this method never passes a client-held expense-id
   * list -- locks and prevalidates every current non-terminal child, and
   * either advances all of them or mutates nothing, returning a structured
   * per-child blocker list.
   *
   * SECURITY REVISION: the RPC also derives next-tier routing (tier/
   * reviewer/engineer) itself, server-side -- this method no longer computes
   * or sends any of that. An earlier draft passed p_next_approval_tier/
   * p_next_assigned_reviewer_id/p_next_assigned_engineer_id as client
   * parameters on the assumption that review_advance_expense_hierarchy_tier
   * independently validated them; reading its live definition proved it does
   * not (it writes assigned_reviewer_id/assigned_engineer_id from whatever
   * the caller supplies, beyond a bare tier-string enum check). Removing
   * these parameters from the RPC's signature entirely closes that gap --
   * there is nothing left for a client to tamper with (DOC-098 same-day
   * security review).
   */
  static async verifyBatchAtomic(
    batchId: string,
    reviewerId: string,
    comment?: string,
    options?: { reviewerRole?: string | null },
  ): Promise<BatchVerifyResult> {
    const organizationId = await getUserOrganizationId(reviewerId);
    if (!organizationId) {
      throw new Error("Reviewer is not associated with an organization");
    }

    const reviewerRole =
      options?.reviewerRole ?? (await this.fetchMembershipRole(organizationId, reviewerId));
    if (reviewerRole !== "team_leader" && reviewerRole !== "executive") {
      throw new Error("Only team leaders and executives can bulk-verify batches");
    }

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "review_verify_batch_atomic_v1",
      {
        p_batch_id: batchId,
        p_comment: comment ?? null,
      },
    );

    throwRpcError(rpcError);

    const result = (rpcResult ?? {}) as Record<string, unknown>;

    if (result.ok === true) {
      const transactions = ((result.transactions as Record<string, unknown>[]) ?? []).map(
        (t) => ({
          transactionNumber: (t.transaction_number as string | null) ?? null,
          employeeId: (t.employee_id as string | null) ?? null,
          statusBefore: String(t.status_before ?? ""),
          statusAfter: String(t.status_after ?? ""),
          tierBefore: (t.tier_before as string | null) ?? null,
          tierAfter: (t.tier_after as string | null) ?? null,
        }),
      );
      return {
        ok: true,
        batchId,
        verifiedCount: Number(result.verified_count ?? transactions.length),
        transactions,
      };
    }

    if (result.code === "batch_not_found") {
      return { ok: false, batchId, code: "batch_not_found" };
    }

    const blockers = ((result.blockers as Record<string, unknown>[]) ?? []).map((b) => ({
      expenseId: String(b.expense_id ?? ""),
      transactionNumber: (b.transaction_number as string | null) ?? null,
      employeeId: (b.employee_id as string | null) ?? null,
      status: String(b.status ?? ""),
      approvalTier: (b.approval_tier as string | null) ?? null,
      reason: String(b.reason ?? ""),
    }));
    return { ok: false, batchId, code: "batch_verification_blocked", blockers };
  }

  static async isBatchExpenseEntryEnabled(organizationId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("organization_features")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("feature_key", ORGANIZATION_FEATURE_KEYS.allow_batch_expense_entry)
      .maybeSingle();
    if (error) {
      console.warn("isBatchExpenseEntryEnabled:", error.message);
      return false;
    }
    return data?.enabled === true;
  }

  static async getBatchExpenseAttachmentMode(
    organizationId: string,
  ): Promise<BatchExpenseAttachmentMode> {
    const { data, error } = await selectFirstOrgSettingsRow(
      organizationId,
      "batch_expense_attachment_mode",
    );
    if (error) return "per_line";
    const mode = data?.batch_expense_attachment_mode as string | undefined;
    return mode === "shared" ? "shared" : "per_line";
  }

  /**
   * Atomically replace ALL custom form-field values for an expense via the
   * `replace_expense_form_field_values` RPC (single transaction, server-side
   * authorization). Throws on failure so callers never report a false success.
   *
   * Pass the complete set of currently-active values (regular template + branch).
   * Anything omitted is removed by the atomic replace.
   */
  static async replaceExpenseFormFieldValues(
    expenseId: string,
    organizationId: string,
    payload: ExpenseCustomFieldValuePayload[],
  ): Promise<number> {
    const { data, error } = await supabase.rpc("replace_expense_form_field_values", {
      p_expense_id: expenseId,
      p_organization_id: organizationId,
      p_values: payload,
    });

    if (error) {
      console.error("[ExpenseService] replaceExpenseFormFieldValues failed", {
        expenseId,
        organizationId,
        code: error.code,
        message: error.message,
      });
      throw error;
    }

    const savedCount =
      data && typeof data === "object" && "saved_count" in data
        ? Number((data as { saved_count: number }).saved_count)
        : payload.length;
    return Number.isFinite(savedCount) ? savedCount : payload.length;
  }

  /**
   * Atomically replace ALL custom form-field values for an expense when a
   * reviewer (engineer, assigned reviewer, manager, executive, team_leader, or
   * admin) applies a correction. Calls the reviewer-scoped RPC which allows
   * write access beyond the expense owner.
   *
   * Migration required before this works:
   *   supabase/migrations/290707_1000_reviewer_custom_field_correction.sql
   */
  private static async replaceExpenseFormFieldValuesByReviewer(
    expenseId: string,
    organizationId: string,
    payload: ExpenseCustomFieldValuePayload[],
  ): Promise<void> {
    if (payload.length === 0) return;
    const { error } = await supabase.rpc("replace_expense_form_field_values_by_reviewer", {
      p_expense_id: expenseId,
      p_organization_id: organizationId,
      p_values: payload,
    });
    if (error) {
      throw new Error(`Failed to save custom field corrections: ${error.message}`);
    }
  }

  /**
   * @deprecated Use {@link replaceExpenseFormFieldValues} with a combined
   * payload. Kept as a thin wrapper so callers that only have regular template
   * values still go through the atomic RPC instead of the old upsert path.
   */
  static async saveExpenseFormFieldValues(
    expenseId: string,
    organizationId: string,
    formFieldValues: Record<string, string>,
  ): Promise<void> {
    const payload = buildExpenseCustomFieldPayload({ templateValues: formFieldValues });
    await this.replaceExpenseFormFieldValues(expenseId, organizationId, payload);
  }

  static async saveBranchFieldValues(
    expenseId: string,
    organizationId: string,
    branchValues: BranchFieldValueMap,
    visibleBranchIds: Set<string>,
  ): Promise<void> {
    const rows = Object.entries(branchValues)
      .filter(([branchId, value]) => visibleBranchIds.has(branchId) && value !== "" && value != null)
      .map(([branchId, value]) => ({
        organization_id: organizationId,
        expense_id: expenseId,
        branch_field_id: branchId,
        template_id: null,
        field_value: String(value),
      }));

    const { data: existing } = await supabase
      .from("expense_form_field_values")
      .select("id, branch_field_id")
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId)
      .not("branch_field_id", "is", null);

    const toDelete = (existing || [])
      .filter((r) => r.branch_field_id && !visibleBranchIds.has(r.branch_field_id))
      .map((r) => r.id);

    if (toDelete.length > 0) {
      await supabase.from("expense_form_field_values").delete().in("id", toDelete);
    }

    if (rows.length === 0) return;

    const { error } = await supabase.from("expense_form_field_values").upsert(rows, {
      onConflict: "expense_id,branch_field_id",
    });
    if (error) console.error("saveBranchFieldValues:", error);
  }

  static async loadBranchFieldValuesForExpense(
    expenseId: string,
    organizationId: string,
  ): Promise<BranchFieldValueMap> {
    const { data, error } = await supabase
      .from("expense_form_field_values")
      .select("branch_field_id, field_value")
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId)
      .not("branch_field_id", "is", null);
    if (error) {
      console.error("loadBranchFieldValuesForExpense:", error);
      return {};
    }
    const map: BranchFieldValueMap = {};
    for (const row of data || []) {
      if (row.branch_field_id) map[row.branch_field_id] = row.field_value;
    }
    return map;
  }

  static async isConditionalDropdownEnabled(organizationId: string): Promise<boolean> {
    const { data } = await supabase
      .from("organization_features")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("feature_key", ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields)
      .maybeSingle();
    return data?.enabled === true;
  }

  static async trackCategoryUsage(
    organizationId: string,
    userId: string,
    categoryName: string,
  ): Promise<void> {
    if (!categoryName) return;
    const { error: rpcError } = await supabase.rpc("increment_category_usage", {
      p_organization_id: organizationId,
      p_user_id: userId,
      p_category_name: categoryName,
    });
    if (!rpcError) return;

    const { data: existing } = await supabase
      .from("category_usage_tracking")
      .select("usage_count")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .eq("category_name", categoryName)
      .maybeSingle();

    const newCount = existing ? Number(existing.usage_count) + 1 : 1;
    await supabase.from("category_usage_tracking").upsert(
      {
        organization_id: organizationId,
        user_id: userId,
        category_name: categoryName,
        usage_count: newCount,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id,category_name" },
    );
  }

  /**
   * Create and submit multiple expenses in one batch (requires org feature allow_batch_expense_entry).
   */
  static async submitExpenseBatch(
    userId: string,
    payload: {
      shared: BatchSubmitSharedInput;
      lines: BatchSubmitLineInput[];
      attachmentMode: BatchExpenseAttachmentMode;
      sharedTempFilenames?: string[];
      metaByFilename: Record<string, TempUploadMeta>;
    },
  ): Promise<BatchSubmitResult> {
    const organizationId = await getUserOrganizationId(userId);
    if (!organizationId) {
      throw new Error("User is not associated with an organization");
    }

    const enabled = await this.isBatchExpenseEntryEnabled(organizationId);
    if (!enabled) {
      throw new Error("Batch expense entry is not enabled for this organization");
    }

    const expenseDateStr = formatExpenseDateString(payload.shared.expenseDate);
    const totalAmount = batchLineTotal(
      payload.lines.map((l) => ({
        clientId: "",
        title: l.title,
        amount: l.amount,
        category: l.category,
        destination: l.destination,
      })),
    );

    const lineCategories = [
      ...new Set(
        payload.lines.map((l) => l.category?.trim()).filter((c): c is string => Boolean(c)),
      ),
    ];
    const sharedCategoryAudit =
      lineCategories.length === 0
        ? null
        : lineCategories.length === 1
          ? lineCategories[0]
          : lineCategories.join(", ");

    const { data: batchRow, error: batchError } = await supabase
      .from("expense_batches")
      .insert({
        organization_id: organizationId,
        user_id: userId,
        label: payload.shared.label?.trim() || null,
        shared_category: sharedCategoryAudit,
        shared_expense_date: expenseDateStr,
        line_count: 0,
        total_amount: totalAmount,
      })
      .select("id")
      .single();

    if (batchError || !batchRow) {
      throw new Error(batchError?.message || "Failed to create expense batch");
    }

    const batchId = batchRow.id as string;
    const results: BatchSubmitLineResult[] = [];
    let successCount = 0;
    let sharedReceiptSourceExpenseId: string | null = null;
    const metaMap = new Map(Object.entries(payload.metaByFilename));

    for (let i = 0; i < payload.lines.length; i++) {
      const line = payload.lines[i];
      try {
        const destination =
          line.destination?.trim() ||
          payload.shared.sharedDestination?.trim() ||
          "—";

        const created = await this.createExpense(userId, {
          title: line.title.trim(),
          destination,
          trip_start: expenseDateStr,
          trip_end: expenseDateStr,
          purpose: line.purpose?.trim() || undefined,
          amount: line.amount,
          category: line.category?.trim() || "other",
        });

        const expenseId = created.id;

        await supabase
          .from("expenses")
          .update({ batch_id: batchId })
          .eq("id", expenseId)
          .eq("organization_id", organizationId);

        if (payload.attachmentMode === "per_line") {
          const temps = line.tempReceiptFilenames ?? [];
          if (temps.length > 0) {
            await moveTempFilesToExpense({
              expenseId,
              userId,
              organizationId,
              tempFileNames: temps,
              metaByFilename: metaMap,
            });
          }
        } else if (payload.attachmentMode === "shared") {
          const temps = payload.sharedTempFilenames ?? [];
          if (temps.length > 0) {
            if (!sharedReceiptSourceExpenseId) {
              await moveTempFilesToExpense({
                expenseId,
                userId,
                organizationId,
                tempFileNames: temps,
                metaByFilename: metaMap,
              });
              sharedReceiptSourceExpenseId = expenseId;
            } else {
              await copyAttachmentsFromExpense({
                sourceExpenseId: sharedReceiptSourceExpenseId,
                targetExpenseId: expenseId,
                userId,
                organizationId,
              });
            }
          }
        }

        await enforceMaxAttachmentSize(expenseId, organizationId);
        await this.submitExpense(expenseId, userId);

        // Single atomic replace for regular + branch values. A failure throws and
        // marks this line as failed (caught below) instead of a false success.
        const hasTemplateValues =
          !!line.formFieldValues && Object.keys(line.formFieldValues).length > 0;
        const hasBranchValues =
          !!line.branchValues && Object.keys(line.branchValues).length > 0;
        if (hasTemplateValues || hasBranchValues) {
          const visibleIds = line.branchValues
            ? new Set(
                line.visibleBranchIds?.length
                  ? line.visibleBranchIds
                  : Object.keys(line.branchValues),
              )
            : undefined;
          const payload = buildExpenseCustomFieldPayload({
            templateValues: line.formFieldValues,
            branchValues: line.branchValues,
            visibleBranchIds: visibleIds,
          });
          await this.replaceExpenseFormFieldValues(expenseId, organizationId, payload);
        }

        const { data: txnRow } = await supabase
          .from("expenses")
          .select("transaction_number")
          .eq("id", expenseId)
          .maybeSingle();

        results.push({
          lineIndex: i,
          ok: true,
          expenseId,
          transactionNumber: (txnRow as { transaction_number?: string | null })?.transaction_number ?? null,
        });
        successCount += 1;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        results.push({ lineIndex: i, ok: false, error: msg });
      }
    }

    await supabase
      .from("expense_batches")
      .update({
        line_count: successCount,
        total_amount: payload.lines
          .filter((_, idx) => results.find((r) => r.lineIndex === idx && r.ok))
          .reduce((s, l) => s + l.amount, 0),
      })
      .eq("id", batchId);

    if (successCount > 0) {
      const succeededCategories = [
        ...new Set(
          payload.lines
            .filter((_, idx) => results.some((r) => r.lineIndex === idx && r.ok))
            .map((l) => l.category?.trim())
            .filter((c): c is string => Boolean(c)),
        ),
      ];
      for (const cat of succeededCategories) {
        await this.trackCategoryUsage(organizationId, userId, cat);
      }
    }

    return {
      batchId,
      results,
      successCount,
      failureCount: payload.lines.length - successCount,
    };
  }

  /**
   * Apply the same review action to multiple expenses (e.g. an entire batch).
   */
  static async processBatchReview(
    expenseIds: string[],
    userId: string,
    action: "verify" | "approve" | "reject",
    comment: string | undefined,
    role: BatchReviewRole,
  ): Promise<{
    results: Array<{ expenseId: string; ok: boolean; error?: string }>;
    successCount: number;
    failureCount: number;
  }> {
    const organizationId = await getUserOrganizationId(userId);
    if (!organizationId) {
      throw new Error("User is not associated with an organization");
    }

    const settled = await Promise.allSettled(
      expenseIds.map((expenseId) => {
        if (action === "reject") {
          return this.rejectExpense(expenseId, userId, comment);
        } else if (action === "approve") {
          return this.approveExpense(expenseId, userId, comment);
        } else {
          if (role === "admin") {
            return this.adminVerifyExpense(expenseId, userId, organizationId, comment);
          } else if (role === "team_leader" || role === "executive") {
            return this.verifyExpense(expenseId, userId, comment, { reviewerRole: role });
          } else {
            return this.verifyExpense(expenseId, userId, comment);
          }
        }
      }),
    );

    const results: Array<{ expenseId: string; ok: boolean; error?: string }> = settled.map(
      (result, i) => ({
        expenseId: expenseIds[i],
        ok: result.status === "fulfilled",
        error:
          result.status === "rejected"
            ? result.reason instanceof Error
              ? result.reason.message
              : "Action failed"
            : undefined,
      }),
    );

    const successCount = results.filter((r) => r.ok).length;
    return {
      results,
      successCount,
      failureCount: results.length - successCount,
    };
  }

  private static async adminVerifyExpense(
    expenseId: string,
    adminId: string,
    organizationId: string,
    comment?: string,
  ): Promise<void> {
    const { data: current, error: curErr } = await supabase
      .from("expenses")
      .select("status")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!current) throw new Error("Expense not found or you don't have access");
    if (!["submitted", "edited"].includes(current.status as string)) {
      throw new Error("Only submitted or adjusted expenses can be verified");
    }

    const { error: rpcError } = await supabase.rpc("review_admin_verify_expense", {
      p_expense_id: expenseId,
      p_comment: comment ?? null,
    });
    throwRpcError(rpcError);

    await this.logAction(
      expenseId,
      adminId,
      organizationId,
      "expense_verified",
      comment || "Status changed to verified",
    );
  }

  /**
   * Submit an expense for review
   * If user is admin, automatically approves and deducts from their balance
   */
  static async submitExpense(
    expenseId: string,
    userId: string,
    options?: { skipAttachmentRequirement?: boolean },
  ): Promise<Expense> {
    // Fetch the expense first so we can use its actual organization_id.
    // This avoids update mismatches when a user has multiple org memberships.
    const { data: expense, error: fetchError } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", expenseId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!expense) throw new Error("Expense not found or you don't have access");

    const organizationId = expense.organization_id as string | null;
    if (!organizationId) throw new Error("Expense is missing organization_id");

    // Batch: org settings + both role checks in parallel — eliminates 3 sequential round-trips
    const [orgSettingsResult, isAdmin, isEngineer] = await Promise.all([
      selectFirstOrgSettingsRow(organizationId, "attachment_required_above_amount"),
      this.hasOrgRole(userId, organizationId, "admin"),
      this.hasOrgRole(userId, organizationId, "engineer"),
    ]);

    const { data: orgSettings, error: orgSettingsSelectError } = orgSettingsResult;
    if (orgSettingsSelectError) throw orgSettingsSelectError;

    const rawLimit = orgSettings?.attachment_required_above_amount;
    const attachmentLimit =
      rawLimit !== null && rawLimit !== undefined && !Number.isNaN(Number(rawLimit))
        ? Number(rawLimit)
        : 50;
    const expenseAmount = Number(expense.total_amount);
    const requiresAttachment = expenseAmount > attachmentLimit;

    if (requiresAttachment && !options?.skipAttachmentRequirement) {
      const { data: attachments, error: attachmentsError } = await supabase
        .from("attachments")
        .select("id")
        .eq("expense_id", expenseId)
        .eq("organization_id", organizationId)
        .limit(1);

      if (attachmentsError) {
        console.error("Error checking attachments:", attachmentsError);
        throw new Error(
          `Failed to verify attachments. Please try again or contact support.`
        );
      } else if (!attachments || attachments.length === 0) {
        throw new Error(
          `Bill photos are required for expenses above ₹${attachmentLimit}. ` +
          `This expense (₹${expenseAmount}) exceeds the limit. Please upload at least one photo of your receipt or bill.`
        );
      }
    }

    if (isAdmin && expense.user_id === userId) {
      if (expense.status !== "submitted") {
        await supabase.from("expenses").update({ status: "submitted" }).eq("id", expenseId);
      }
      return await this.approveExpense(expenseId, userId, "Auto-approved: Admin expense");
    }

    // Inline permission check — no extra DB round-trip (expense + role already fetched above)
    const canEdit = isAdmin || (expense.user_id === userId && canOwnerEditExpenseStatus(expense.status));
    if (!canEdit) {
      throw new Error("You don't have permission to submit this expense");
    }

    const isResubmission = expense.status === "rejected";
    if (expense.status !== "submitted" && expense.status !== "rejected" && expense.status !== "draft") {
      throw new Error("Only draft, submitted, or rejected expenses can be submitted");
    }

    if (isEngineer) {
      // Engineers' expenses go directly to admin (no engineer assignment)
      const updatePayload: any = {
        status: "submitted",
        assigned_engineer_id: null, // No engineer assignment - goes to admin
        updated_at: new Date().toISOString(),
      };

      const { data: updatedExpense, error: updateError } = await supabase
        .from("expenses")
        .update(updatePayload)
        .eq("id", expenseId)
        .eq("organization_id", organizationId)
        .select()
        .maybeSingle();

      if (updateError) throw updateError;
      // Some orgs/environments may block "UPDATE ... returning" via RLS/select policies.
      // Treat it as success if the row can be refetched.
      let submittedExpense = updatedExpense;
      if (!submittedExpense) {
        const { data: refetched, error: refetchErr } = await supabase
          .from("expenses")
          .select("id, status, title")
          .eq("id", expenseId)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (refetchErr) throw refetchErr;
        submittedExpense = refetched ?? null;
      }
      if (!submittedExpense) throw new Error("Failed to submit expense (row not found after update)");
      if (submittedExpense.status !== "submitted") {
        throw new Error(
          `Submission failed: expense status is still "${submittedExpense.status}". Please try again or contact support.`
        );
      }

      // Log + notify fire-and-forget — expense.title already fetched; don't block the response
      const engineerExpenseTitle = expense.title as string | undefined;
      void (async () => {
        const actionType = isResubmission ? "expense_resubmitted" : "expense_submitted";
        const logMsg = isResubmission
          ? `Expense resubmitted after rejection by engineer - sent directly to admin`
          : `Expense submitted by engineer - sent directly to admin`;
        await this.logAction(expenseId, userId, organizationId, actionType, logMsg);
        const [profileResult, adminMembershipsResult] = await Promise.all([
          selectFirstProfileRow(userId, "name"),
          supabase.from("organization_memberships").select("user_id")
            .eq("organization_id", organizationId).eq("role", "admin").eq("is_active", true),
        ]);
        const engineerName = (profileResult.data?.name as string | undefined) || "Engineer";
        const adminUserIds = adminMembershipsResult.data?.map((m) => m.user_id) || [];
        if (engineerExpenseTitle && adminUserIds.length > 0) {
          void notifyExpenseSubmitted(expenseId, engineerExpenseTitle, engineerName, null, adminUserIds)
            .catch((e) => console.error("notifyExpenseSubmitted failed (engineer→admin):", e));
        }
        if (engineerExpenseTitle) {
          void notifyExpenseSubmissionProgress(expenseId, engineerExpenseTitle, userId, "Admin")
            .catch((e) => console.error("notifyExpenseSubmissionProgress failed:", e));
        }
      })().catch((e) => console.error("engineer submitExpense post-submit tasks failed:", e));

      return submittedExpense as Expense;
    }

    // Batch: profile + submitter role + hierarchy context in parallel — eliminates 4 sequential round-trips
    const [profileResult, submitterRole, hierarchyCtx] = await Promise.all([
      selectFirstProfileRow(userId, "reporting_engineer_id, name"),
      this.fetchMembershipRole(organizationId, userId),
      this.loadHierarchyContext(organizationId, userId),
    ]);
    const { data: profileRow, error: profileError } = profileResult;
    if (profileError) throw profileError;
    const employeeName = (profileRow?.name as string | undefined) || "Employee";

    const reportingEngineerId =
      (profileRow?.reporting_engineer_id as string | null | undefined) ?? null;
    const reportingSupervisorRole = reportingEngineerId
      ? await this.fetchMembershipRole(organizationId, reportingEngineerId)
      : null;

    const { flags, team, fallbackAdminUserId } = hierarchyCtx;

    let updatePayload: Record<string, unknown>;
    if (flags.approval_hierarchy) {
      const hierarchyInput = {
        flags,
        team,
        reportingEngineerId,
        reportingSupervisorRole,
        submitterRole,
        fallbackAdminUserId,
      };
      const assignment = resolveInitialAssignment(hierarchyInput);
      const managingEngineerId = resolveManagingEngineerId(hierarchyInput);
      updatePayload = {
        status: "submitted",
        approval_tier: assignment.approval_tier,
        assigned_reviewer_id: assignment.assigned_reviewer_id,
        assigned_engineer_id: managingEngineerId ?? assignment.assigned_engineer_id,
        updated_at: new Date().toISOString(),
      };
    } else {
      updatePayload = {
        status: "submitted",
        assigned_engineer_id: reportingEngineerId,
        approval_tier: null,
        assigned_reviewer_id: reportingEngineerId,
        updated_at: new Date().toISOString(),
      };
    }

    const { data: updatedExpense, error: updateError } = await supabase
      .from("expenses")
      .update(updatePayload)
      .eq("id", expenseId)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;
    let submittedExpense = updatedExpense;
    if (!submittedExpense) {
      const { data: refetched, error: refetchErr } = await supabase
        .from("expenses")
        .select("id, status, title")
        .eq("id", expenseId)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (refetchErr) throw refetchErr;
      submittedExpense = refetched ?? null;
    }
    if (!submittedExpense) throw new Error("Failed to submit expense (row not found after update)");
    if (submittedExpense.status !== "submitted") {
      throw new Error(
        `Submission failed: expense status is still "${submittedExpense.status}". Please try again or contact support.`
      );
    }

    // expense.title and employeeName are already fetched — no extra round-trips needed.
    // Logging and notifications are non-critical side effects: run fire-and-forget so the
    // submit response reaches the user as soon as the DB update is confirmed.
    const expenseTitle = expense.title as string | undefined;
    void (async () => {
      const actionType = isResubmission ? "expense_resubmitted" : "expense_submitted";
      const hierarchyAssignment = flags.approval_hierarchy
        ? resolveInitialAssignment({
            flags, team, reportingEngineerId, reportingSupervisorRole,
            submitterRole, fallbackAdminUserId,
          })
        : null;
      const notifyReviewerId =
        hierarchyAssignment?.assigned_reviewer_id ??
        (hierarchyAssignment?.approval_tier === "engineer"
          ? hierarchyAssignment.assigned_engineer_id
          : null) ??
        reportingEngineerId;

      if (notifyReviewerId) {
        const reviewerName = await resolveProfileDisplayName(notifyReviewerId);
        const tierLabel = hierarchyAssignment?.approval_tier ?? "engineer";
        const logMsg = isResubmission
          ? `Expense resubmitted after rejection and assigned to ${reviewerName} (${tierLabel}) for review`
          : `Expense submitted and assigned to ${reviewerName} (${tierLabel}) for review`;
        await this.logAction(expenseId, userId, organizationId, actionType, logMsg);
        if (expenseTitle) {
          const reviewerLabel = hierarchyAssignment?.approval_tier
            ? hierarchyAssignment.approval_tier.replace(/_/g, " ")
            : "Manager";
          void notifyExpenseSubmitted(expenseId, expenseTitle, employeeName, notifyReviewerId)
            .catch((e) => console.error("notifyExpenseSubmitted failed:", e));
          void notifyExpenseSubmissionProgress(expenseId, expenseTitle, userId, reviewerLabel)
            .catch((e) => console.error("notifyExpenseSubmissionProgress failed:", e));
        }
      } else if (flags.approval_hierarchy && hierarchyAssignment?.approval_tier === "admin") {
        const logMsg = isResubmission
          ? `Expense resubmitted after rejection — sent to admin queue`
          : `Expense submitted — sent to admin queue (hierarchy)`;
        await this.logAction(expenseId, userId, organizationId, actionType, logMsg);
        const { data: adminMemberships } = await supabase
          .from("organization_memberships").select("user_id")
          .eq("organization_id", organizationId).eq("role", "admin").eq("is_active", true);
        const adminUserIds = adminMemberships?.map((m) => m.user_id) || [];
        if (expenseTitle && adminUserIds.length > 0) {
          void notifyExpenseSubmitted(expenseId, expenseTitle, employeeName, null, adminUserIds)
            .catch((e) => console.error("notifyExpenseSubmitted failed (admin hierarchy):", e));
        }
        if (expenseTitle) {
          void notifyExpenseSubmissionProgress(expenseId, expenseTitle, userId, "Admin")
            .catch((e) => console.error("notifyExpenseSubmissionProgress failed:", e));
        }
      } else if (reportingEngineerId) {
        const engineerName = await resolveProfileDisplayName(reportingEngineerId);
        const logMsg = isResubmission
          ? `Expense resubmitted after rejection and assigned to ${engineerName} for review`
          : `Expense submitted and assigned to ${engineerName} for review`;
        await this.logAction(expenseId, userId, organizationId, actionType, logMsg);
        if (expenseTitle) {
          void notifyExpenseSubmitted(expenseId, expenseTitle, employeeName, reportingEngineerId)
            .catch((e) => console.error("notifyExpenseSubmitted failed (engineer):", e));
          void notifyExpenseSubmissionProgress(expenseId, expenseTitle, userId, "Manager")
            .catch((e) => console.error("notifyExpenseSubmissionProgress failed:", e));
        }
      } else {
        const logMsg = isResubmission
          ? `Expense resubmitted after rejection by employee without assigned engineer - sent directly to admin`
          : `Expense submitted by employee without assigned engineer - sent directly to admin`;
        await this.logAction(expenseId, userId, organizationId, actionType, logMsg);
        const { data: adminMemberships } = await supabase
          .from("organization_memberships").select("user_id")
          .eq("organization_id", organizationId).eq("role", "admin").eq("is_active", true);
        const adminUserIds = adminMemberships?.map((m) => m.user_id) || [];
        if (expenseTitle && adminUserIds.length > 0) {
          void notifyExpenseSubmitted(expenseId, expenseTitle, employeeName, null, adminUserIds)
            .catch((e) => console.error("notifyExpenseSubmitted failed (admin no engineer):", e));
        }
        if (expenseTitle) {
          void notifyExpenseSubmissionProgress(expenseId, expenseTitle, userId, "Admin")
            .catch((e) => console.error("notifyExpenseSubmissionProgress failed:", e));
        }
      }
    })().catch((e) => console.error("submitExpense post-submit tasks failed:", e));

    return submittedExpense as Expense;
  }

  /**
   * Assign expense to an engineer
   */
  static async assignToEngineer(
    expenseId: string,
    engineerId: string,
    adminId: string
  ): Promise<Expense> {
    // Get admin's organization_id
    const organizationId = await getUserOrganizationId(adminId);
    if (!organizationId) {
      throw new Error("Admin is not associated with an organization");
    }

    // Check if admin has permission
    const isAdmin = await this.hasOrgRole(adminId, organizationId, "admin");
    if (!isAdmin) {
      throw new Error("Only administrators can assign expenses to engineers");
    }

    // Check if engineer exists and has engineer role in same organization
    const isEngineer = await this.hasOrgRole(engineerId, organizationId, "engineer");
    if (!isEngineer) {
      throw new Error("Assigned user must have engineer role in your organization");
    }

    // Update expense (filtered by organization)
    const { data: updatedExpense, error: updateError } = await supabase
      .from("expenses")
      .update({
        assigned_engineer_id: engineerId,
        status: "submitted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updatedExpense) throw new Error("Failed to assign expense (no row returned)");

    const engineerName = await resolveProfileDisplayName(engineerId);
    await this.logAction(
      expenseId,
      adminId,
      organizationId,
      "expense_assigned",
      `Assigned to ${engineerName} for review`,
    );

    return updatedExpense;
  }

  /**
   * Verify expense (engineer action)
   */
  static async verifyExpense(
    expenseId: string,
    engineerId: string,
    comment?: string,
    options?: { reviewerRole?: string | null },
  ): Promise<Expense> {
    const organizationId = await getUserOrganizationId(engineerId);
    if (!organizationId) {
      throw new Error("Reviewer is not associated with an organization");
    }

    const reviewerRole =
      options?.reviewerRole ??
      (await this.fetchMembershipRole(organizationId, engineerId));

    if (reviewerRole === "team_leader" || reviewerRole === "executive") {
      return this.advanceExpenseTier(
        expenseId,
        engineerId,
        comment,
        reviewerRole,
      );
    }

    const [head, { flags }] = await Promise.all([
      this.fetchExpenseReviewHead(expenseId, organizationId),
      this.loadHierarchyContext(organizationId, engineerId),
    ]);
    if (!head) {
      throw new Error("Expense not found or you don't have access");
    }
    const tier = head.approval_tier;
    if (tier === "team_leader" || tier === "executive") {
      const tierEnabled =
        flags.approval_hierarchy &&
        ((tier === "team_leader" && flags.hierarchy_team_leader) ||
          (tier === "executive" && flags.hierarchy_executive));
      if (tierEnabled) {
        throw new Error(
          "This expense must be verified by the team leader or executive assigned to it before manager approval.",
        );
      }
    }

    const canReview = await this.canReviewerActOnExpense(
      expenseId,
      engineerId,
      organizationId,
    );
    if (!canReview) {
      throw new Error("You don't have permission to review this expense");
    }
    if (head.status === "approved") {
      throw new Error("This expense is already approved and cannot be updated");
    }
    let managerReady =
      head.status === "level_2_verified" ||
      (head.approval_tier === "engineer" &&
        ["submitted", "edited", "level_1_verified"].includes(head.status));

    if (!managerReady) {
      const handoffIds = await fetchExecutiveHandoffExpenseIds(
        supabase,
        organizationId,
        [expenseId],
      );
      managerReady = computeManagerQueueReady(
        {
          id: expenseId,
          status: head.status,
          approval_tier: head.approval_tier,
        },
        handoffIds,
        flags.approval_hierarchy,
        {
          teamLeaderTierEnabled: flags.hierarchy_team_leader,
          executiveTierEnabled: flags.hierarchy_executive,
        },
      );
    }

    if (!managerReady) {
      throw new Error(
        "This expense is not ready for manager verification. It must be Level 2 Verified or assigned to the manager queue after executive approval.",
      );
    }

    const { data: rpcResult, error: rpcError } = await supabase.rpc("review_verify_expense", {
      p_expense_id: expenseId,
      p_comment: comment ?? null,
    });

    throwRpcError(rpcError);

    const verifyFallback = {
      id: expenseId,
      organization_id: organizationId,
      status: "verified",
      approval_tier: tier,
      assigned_reviewer_id: head.assigned_reviewer_id,
      assigned_engineer_id: head.assigned_engineer_id,
    } as Expense;

    const { data: refetchedExpense, error: fetchError } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    const updatedExpense = expenseFromReviewRpc(
      rpcResult,
      (refetchedExpense ?? verifyFallback) as Expense,
    );

    // Parallel: log + fetch engineer profile (reuse refetchedExpense for expense data — no extra query)
    const [, engineerProfileResult] = await Promise.all([
      this.logAction(expenseId, engineerId, organizationId, "expense_verified", comment),
      selectFirstProfileRow(engineerId, "name"),
    ]);
    const { data: engineerRow, error: engProfErr } = engineerProfileResult;
    if (engProfErr) console.error("verifyExpense: engineer profile", engProfErr);
    const engineerName = (engineerRow?.name as string | undefined) || "Engineer";

    if (refetchedExpense) {
      // Parallel: employee name + org settings
      const [employeeProfileResult, orgSettingsResult] = await Promise.all([
        selectFirstProfileRow(refetchedExpense.user_id as string, "name"),
        selectFirstOrgSettingsRow(organizationId, "engineer_approval_limit"),
      ]);
      const { data: employeeRow, error: empProfErr } = employeeProfileResult;
      if (empProfErr) console.error("verifyExpense: employee profile", empProfErr);
      const employeeName = (employeeRow?.name as string | undefined) || "Employee";

      // Create notification for employee (fire-and-forget)
      void notifyExpenseVerified(
        expenseId,
        refetchedExpense.title as string,
        refetchedExpense.user_id as string,
        engineerName
      );

      const { data: orgSettings, error: orgLimErr } = orgSettingsResult;
      if (orgLimErr) console.error("verifyExpense: organization_settings", orgLimErr);

      const rawLimit = orgSettings?.engineer_approval_limit;
      const approvalLimit =
        rawLimit === null || rawLimit === undefined || Number(rawLimit) <= 0
          ? Number.POSITIVE_INFINITY
          : Number(rawLimit);
      const expenseAmount = Number(refetchedExpense.total_amount);

      // If expense is at or above threshold, notify all admins in organization
      if (Number.isFinite(approvalLimit) && expenseAmount >= approvalLimit) {
        const { data: adminMemberships } = await supabase
          .from("organization_memberships")
          .select("user_id")
          .eq("organization_id", organizationId)
          .eq("role", "admin")
          .eq("is_active", true);

        const adminUserIds = adminMemberships?.map(m => m.user_id) || [];

        if (adminUserIds.length > 0) {
          void notifyExpenseVerifiedToAdmin(
            expenseId,
            refetchedExpense.title as string,
            employeeName,
            engineerName,
            expenseAmount,
            adminUserIds
          );
        }
      }
    }

    return updatedExpense;
  }

  /**
   * Approve expense (admin or engineer action)
   */
  static async approveExpense(
    expenseId: string,
    approverId: string,
    comment?: string
  ): Promise<Expense> {
    // Get approver's organization_id
    const organizationId = await getUserOrganizationId(approverId);
    if (!organizationId) {
      throw new Error("Approver is not associated with an organization");
    }

    const [isAdmin, isEngineer, isTeamLeader, isExecutive] = await Promise.all([
      this.hasOrgRole(approverId, organizationId, "admin"),
      this.hasOrgRole(approverId, organizationId, "engineer"),
      this.hasOrgRole(approverId, organizationId, "team_leader"),
      this.hasOrgRole(approverId, organizationId, "executive"),
    ]);

    const approverRole = isAdmin
      ? "admin"
      : isEngineer
        ? "engineer"
        : isTeamLeader
          ? "team_leader"
          : isExecutive
            ? "executive"
            : "";

    if (!canRoleApprove(approverRole)) {
      throw new Error("Only managers or administrators can approve expenses");
    }

    const { data: expense, error: fetchError } = await supabase
      .from('expenses')
      .select(
        'id, user_id, total_amount, title, status, approval_tier, assigned_reviewer_id, assigned_engineer_id',
      )
      .eq('id', expenseId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!expense) throw new Error("Expense not found or you don't have access");

    const hierarchyFlags = await this.getHierarchyFeatureFlags(organizationId);
    if (hierarchyFlags.approval_hierarchy) {
      const tier = expense.approval_tier as ApprovalTier | null;
      if (
        !isAdmin &&
        (tier === "team_leader" || tier === "executive")
      ) {
        throw new Error(
          "This expense must be verified by the team leader or executive before approval",
        );
      }
      if (tier === "engineer" && isEngineer) {
        const canReview = await this.canReviewerActOnExpense(
          expenseId,
          approverId,
          organizationId,
        );
        if (!canReview) {
          throw new Error("You are not assigned to approve this expense");
        }
      }
    }

    if (expense.status === "approved") {
      throw new Error("This expense is already approved");
    }
    
    // Engineers (manager role) can approve submitted/edited in classic flow.
    // In hierarchy flow, managers can also approve Level 2 verified expenses.
    const engineerAllowedStatuses =
      hierarchyFlags.approval_hierarchy
        ? ["submitted", "edited", "level_2_verified"]
        : ["submitted", "edited"];
    if (isEngineer && !engineerAllowedStatuses.includes(expense.status)) {
      throw new Error(
        hierarchyFlags.approval_hierarchy
          ? "Managers can only approve submitted, adjusted, or Level 2 verified expenses"
          : "Engineers can only approve submitted or adjusted expenses",
      );
    }
    
    // Check engineer approval limit if engineer is trying to approve
    if (isEngineer) {
      const { data: engineerLimitRow, error: limitError } = await selectFirstOrgSettingsRow(
        organizationId,
        "engineer_approval_limit"
      );

      if (limitError) {
        console.error("Error fetching engineer approval limit:", limitError);
        throw new Error("Unable to verify approval limit. Please contact administrator.");
      }

      const rawLimit = engineerLimitRow?.engineer_approval_limit;
      const approvalLimit =
        rawLimit === null || rawLimit === undefined || Number(rawLimit) <= 0
          ? Number.POSITIVE_INFINITY
          : Number(rawLimit);
      const expenseAmount = Number(expense.total_amount);
      
      console.log("Manager approval check:", { 
        expenseAmount, 
        approvalLimit, 
        exceeds: expenseAmount > approvalLimit,
        expenseId: expense.id
      });
      
      // Engineers can only approve if expense amount <= limit
      // If expense amount > limit, they must verify instead
      if (Number.isFinite(approvalLimit) && expenseAmount > approvalLimit) {
        throw new Error(
          `This expense (${formatINR(expenseAmount)}) exceeds the manager approval limit of ${formatINR(approvalLimit)}. ` +
          `Please verify this expense instead. It will be sent to admin for final approval.`
        );
      }
    }
    
    if (isAdmin && !isAdminApprovableStatus(expense.status)) {
      throw new Error(
        "Admins can only approve submitted, verified, adjusted, or hierarchy-verified expenses",
      );
    }
    
    // DOC-089 — approval and balance deduction are ONE server transaction.
    //
    // Everything below the RPC call used to live in the browser: read balance,
    // subtract in JavaScript, write profiles.balance filtered only by user_id,
    // then log what JavaScript had calculated. Engineers have no UPDATE policy
    // on profiles, so that write silently matched zero rows — PostgREST does not
    // error on an RLS-filtered zero-row UPDATE — and the expense committed as
    // approved with the balance untouched.
    //
    // review_approve_expense_v2 now locks the expense, locks the single matching
    // profile (organization_id AND user_id), delegates authorization to V1,
    // performs the arithmetic in SQL, and writes both the deduction evidence and
    // the audit entry. If any step fails the approval rolls back with it.
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "review_approve_expense_v2",
      { p_expense_id: expenseId, p_comment: comment ?? null },
    );
    throwRpcError(rpcError);

    const approval = parseApproveExpenseV2Result(rpcResult);
    const updatedExpense = expenseFromReviewRpc(rpcResult, expense as Expense);
    if (updatedExpense.status !== "approved") {
      throw new Error("Failed to approve expense");
    }

    // Server-confirmed amount — never the pre-approval client value.
    const expenseAmount = approval.balance.deducted;

    // The expense_verified audit row is written inside the same transaction by
    // V2 when an admin auto-verifies, so it is NOT logged again here. Only the
    // notification (a non-financial side effect) remains on the client.
    if (approval.auto_verified) {
      const { data: adminProfileRow, error: adminProfErr } = await selectFirstProfileRow(
        approverId,
        "name",
      );
      if (adminProfErr) console.error("approveExpense (auto-verify): admin profile", adminProfErr);
      const adminProfile = adminProfileRow ? { name: adminProfileRow.name as string | undefined } : null;

      void notifyExpenseVerified(
        expenseId,
        expense.title,
        expense.user_id,
        adminProfile?.name || "Admin",
      );
    }

    // Notifications only — the financial record is already committed server-side.
    const [approverProfileResult, expenseOwnerIsEngineer] = await Promise.all([
      selectFirstProfileRow(approverId, "name"),
      this.hasOrgRole(expense.user_id, organizationId, "engineer"),
    ]);
    const { data: approverRow, error: approverProfErr } = approverProfileResult;
    if (approverProfErr) console.error("approveExpense: approver profile", approverProfErr);
    const approverProfile = approverRow
      ? { name: approverRow.name as string | undefined }
      : null;

    if (expenseOwnerIsEngineer) {
      void notifyEngineerExpenseApproved(
        expenseId,
        expense.title,
        expense.user_id,
        approverProfile?.name || (isAdmin ? "Admin" : "Engineer"),
        expenseAmount
      );
    } else {
      void notifyExpenseApproved(
        expenseId,
        expense.title,
        expense.user_id,
        approverProfile?.name || (isAdmin ? "Admin" : "Engineer"),
        expenseAmount
      );
    }

    return updatedExpense;
  }

  /**
   * Manager (engineer) override approval for an expense still WAITING at a later
   * hierarchy tier (§14). Routes through review_approve_expense_manager_override_v1,
   * which re-authorizes everything server-side (engineer-only, same org, manager
   * scope, no self-review, non-terminal, engineer_approval_limit) and performs the
   * SAME atomic balance deduction as review_approve_expense_v2 — one shared
   * expense_balance_deductions UNIQUE(expense_id), no browser balance write.
   *
   * The RPC is intentionally absent from the stale generated types; a single
   * isolated cast avoids hand-editing them (DOC-079). Known authorization
   * failures surface as the server's own message so the caller can report them.
   */
  static async approveExpenseManagerOverride(
    expenseId: string,
    comment?: string,
  ): Promise<{ ok: true; balance: { before: number; deducted: number; after: number } }> {
    const client = supabase as unknown as {
      rpc: (
        n: string,
        p: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
    };
    const { data, error } = await client.rpc("review_approve_expense_manager_override_v1", {
      p_expense_id: expenseId,
      p_comment: comment ?? null,
    });
    if (error) throw new Error(error.message || "Manager override approval failed");

    const result = data as
      | { ok?: boolean; balance?: { before?: number; deducted?: number; after?: number } }
      | null;
    if (!result || result.ok !== true) {
      throw new Error("Manager override approval failed");
    }
    const b = result.balance ?? {};
    return {
      ok: true,
      balance: {
        before: Number(b.before ?? 0),
        deducted: Number(b.deducted ?? 0),
        after: Number(b.after ?? 0),
      },
    };
  }

  /**
   * Reject expense (admin or engineer action)
   */
  static async rejectExpense(
    expenseId: string,
    rejectorId: string,
    comment?: string
  ): Promise<Expense> {
    // Get rejector's organization_id
    const organizationId = await getUserOrganizationId(rejectorId);
    if (!organizationId) {
      throw new Error("Rejector is not associated with an organization");
    }

    const [isAdmin, isEngineer, isTeamLeader, isExecutive] = await Promise.all([
      this.hasOrgRole(rejectorId, organizationId, "admin"),
      this.hasOrgRole(rejectorId, organizationId, "engineer"),
      this.hasOrgRole(rejectorId, organizationId, "team_leader"),
      this.hasOrgRole(rejectorId, organizationId, "executive"),
    ]);

    if (
      !isAdmin &&
      !isEngineer &&
      !isTeamLeader &&
      !isExecutive
    ) {
      throw new Error("You don't have permission to reject this expense");
    }

    const { data: expense, error: fetchError } = await supabase
      .from("expenses")
      .select("id, user_id, title, status, approval_tier, assigned_reviewer_id")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!expense) throw new Error("Expense not found or you don't have access");

    // Check if expense can be rejected (not already approved or rejected)
    if (expense.status === "approved") {
      throw new Error("Approved expenses cannot be rejected");
    }
    if (expense.status === "rejected") {
      throw new Error("This expense is already rejected");
    }

    if (!isAdmin) {
      const canReview = await this.canReviewerActOnExpense(
        expenseId,
        rejectorId,
        organizationId,
      );
      if (!canReview) {
        throw new Error("You don't have permission to reject this expense");
      }
    }

    const { data: rpcResult, error: rpcError } = await supabase.rpc("review_reject_expense", {
      p_expense_id: expenseId,
      p_comment: comment ?? null,
    });

    throwRpcError(rpcError);

    const rejectFallback = {
      ...(expense as Expense),
      organization_id: organizationId,
      status: "rejected",
      admin_comment: comment ?? null,
      approval_tier: null,
      assigned_reviewer_id: null,
    } as Expense;

    const { data: refetchedExpense, error: refetchError } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (refetchError) throw refetchError;

    const updatedExpense = expenseFromReviewRpc(
      rpcResult,
      (refetchedExpense ?? rejectFallback) as Expense,
    );

    // Parallel: log + fetch rejector name for notification
    const [, rejectorProfileResult] = await Promise.all([
      this.logAction(expenseId, rejectorId, organizationId, "expense_rejected", comment),
      selectFirstProfileRow(rejectorId, "name"),
    ]);
    const { data: rejectorRow, error: rejectorProfErr } = rejectorProfileResult;
    if (rejectorProfErr) console.error("rejectExpense: rejector profile", rejectorProfErr);
    const rejectorProfile = rejectorRow
      ? { name: rejectorRow.name as string | undefined }
      : null;

    // Send notification to expense owner (fire-and-forget — doesn't block response)
    void notifyExpenseRejected(
      expenseId,
      expense.title,
      expense.user_id,
      rejectorProfile?.name || (isAdmin ? "Admin" : "Engineer"),
      comment
    );

    return updatedExpense;
  }

  /**
   * Get expense with line items
   */
  static async getExpense(expenseId: string, userId: string): Promise<ExpenseWithLineItems | null> {
    // Get user's organization_id
    const organizationId = await getUserOrganizationId(userId);
    if (!organizationId) return null;

    // Get expense (filtered by organization)
    const { data: expense, error: expenseError } = await supabase
      .from("expenses")
      .select("*")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (expenseError) return null;
    if (!expense) return null;

    // Get line items (filtered by organization)
    const { data: lineItems, error: lineItemsError } = await supabase
      .from("expense_line_items")
      .select("*")
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId);

    if (lineItemsError) return null;

    return {
      ...expense,
      expense_line_items: lineItems || [],
    };
  }

  /**
   * Check if user can edit expense
   */
  private static async canUserEditExpense(expenseId: string, userId: string, organizationId?: string): Promise<boolean> {
    // Get organization_id if not provided
    if (!organizationId) {
      organizationId = await getUserOrganizationId(userId);
      if (!organizationId) return false;
    }

    // Check if user is admin in this organization
    const isAdmin = await this.hasOrgRole(userId, organizationId, "admin");
    if (isAdmin) return true;

    // Check if user is engineer (manager) - they can submit their own expenses
    const isEngineer = await this.hasOrgRole(userId, organizationId, "engineer");
    
    // Check if user owns the expense (filtered by organization)
    const { data: expense, error } = await supabase
      .from("expenses")
      .select("user_id, status, organization_id")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (error) {
      console.error('❌ [ExpenseService] Error fetching expense for edit check:', error);
      return false;
    }

    if (!expense) {
      console.error('❌ [ExpenseService] Expense not found:', expenseId);
      return false;
    }

    console.log('🔍 [ExpenseService] Expense ownership check:', {
      expenseUserId: expense.user_id,
      currentUserId: userId,
      expenseStatus: expense.status,
      expenseOrgId: expense.organization_id,
      currentOrgId: organizationId,
      isOwner: expense.user_id === userId,
      allowedStatuses: ['submitted', 'draft', 'rejected'],
      statusMatches: ['submitted', 'draft', 'rejected'].includes(expense.status)
    });

    // Owner may edit when status allows (same rules as UI / RLS for batch and single expenses).
    const canEdit =
      expense.user_id === userId && canOwnerEditExpenseStatus(expense.status);
    console.log('✅ [ExpenseService] Final canEdit result:', canEdit);
    return canEdit;
  }

  /**
   * Check if manager can review expense
   */
  private static async canReviewerActOnExpense(
    expenseId: string,
    reviewerId: string,
    organizationId: string,
  ): Promise<boolean> {
    const { data: visibleToManager, error: visibleError } = await supabase.rpc(
      "manager_expense_visible_to_user",
      { p_expense_id: expenseId, p_manager_id: reviewerId },
    );
    if (!visibleError && visibleToManager === true) {
      return true;
    }
    if (visibleError) {
      if (import.meta.env.DEV) {
        console.warn("manager_expense_visible_to_user RPC failed:", {
          organizationId,
          reviewerId,
          expenseId,
          message: visibleError.message,
        });
      } else {
        console.warn("manager_expense_visible_to_user RPC failed:", visibleError.message);
      }
    }

    // Backward compatibility fallback for orgs missing the new RPC migration.
    const { data: rpcAllowed, error: rpcError } = await supabase.rpc("reviewer_can_act_on_expense", {
      p_expense_id: expenseId,
    });
    if (!rpcError && rpcAllowed === true) return true;

    const { data: expense, error } = await supabase
      .from("expenses")
      .select("status, assigned_engineer_id, assigned_reviewer_id, approval_tier, user_id")
      .eq("id", expenseId)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (error || !expense) return false;

    const tier = expense.approval_tier as ApprovalTier | null;
    const reviewerRole = await this.fetchMembershipRole(organizationId, reviewerId);

    if (
      canRoleActOnExpense(
        reviewerRole ?? "",
        tier,
        expense.assigned_reviewer_id,
        reviewerId,
        expense.assigned_engineer_id,
      )
    ) {
      return true;
    }

    if (expense.assigned_engineer_id === reviewerId) return true;

    if (tier === "engineer" && expense.assigned_reviewer_id === reviewerId) {
      return true;
    }
    if (tier && expense.assigned_reviewer_id === reviewerId) {
      return true;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("reporting_engineer_id")
      .eq("user_id", expense.user_id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (profile?.reporting_engineer_id === reviewerId) return true;

    // Legacy tenant fallback: some profile rows are not scoped by organization_id.
    if (!profile?.reporting_engineer_id) {
      const { data: legacyProfile } = await supabase
        .from("profiles")
        .select("reporting_engineer_id")
        .eq("user_id", expense.user_id)
        .maybeSingle();
      if (legacyProfile?.reporting_engineer_id === reviewerId) return true;
    }

    // Defensive fallback for stale assignment rows when hierarchy repair RPCs are not deployed.
    // Only allow this at manager stage to avoid broadening earlier-tier permissions.
    if (
      reviewerRole === "engineer" &&
      expense.approval_tier === "engineer" &&
      expense.status === "level_2_verified"
    ) {
      return true;
    }

    return isUserTeamManagerForExpense(
      supabase,
      organizationId,
      reviewerId,
      expense.user_id,
      await this.isOrganizationFeatureEnabled(
        organizationId,
        ORGANIZATION_FEATURE_KEYS.teams_enabled,
      ),
    );
  }

  /** @deprecated Use canReviewerActOnExpense */
  private static async canEngineerReviewExpense(
    expenseId: string,
    engineerId: string,
    organizationId: string,
  ): Promise<boolean> {
    return this.canReviewerActOnExpense(expenseId, engineerId, organizationId);
  }

  private static async hasOrgRole(
    userId: string,
    organizationId: string,
    role:
      | "admin"
      | "engineer"
      | "employee"
      | "cashier"
      | "team_leader"
      | "executive",
  ): Promise<boolean> {
    // Return false if userId is empty or invalid
    if (!userId || userId.trim() === "") {
      return false;
    }

    const { data, error } = await supabase
      .from("organization_memberships")
      .select("role")
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .eq("role", role)
      .eq("is_active", true)
      .maybeSingle();

    if (error) return false;

    return !!data;
  }

  /**
   * Log action in audit trail
   */
  private static async logAction(
    expenseId: string,
    userId: string,
    organizationId: string,
    action: string,
    comment?: string
  ): Promise<void> {
    // Some deployments have `audit_logs` without `organization_id`. Try the richer insert first,
    // then fall back to the minimal payload.
    const payload: any = {
      expense_id: expenseId,
      user_id: userId,
      action,
      comment,
    };

    try {
      await supabase
        .from("audit_logs")
        .insert({
          ...payload,
          organization_id: organizationId,
        });
    } catch (e) {
      await supabase
        .from("audit_logs")
        .insert(payload);
    }
  }
}
