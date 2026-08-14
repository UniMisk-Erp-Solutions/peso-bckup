import { supabase } from "@/integrations/supabase/client";
import { formatINR } from "@/lib/format";

export type NotificationType = 
  | "expense_verified" 
  | "expense_approved" 
  | "expense_submitted" 
  | "expense_rejected"
  | "balance_added"
  | "transfer_offer_received"
  | "transfer_offer_accepted"
  | "transfer_offer_rejected"
  | "transfer_offer_cancelled";

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  expenseId?: string;
  organizationId?: string; // Optional - will be fetched if not provided
}

/**
 * Get organization_id for a user
 */
async function getUserOrganizationId(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      console.error("Error fetching user organization:", error);
      return null;
    }

    return data?.organization_id || null;
  } catch (error) {
    console.error("Error fetching user organization:", error);
    return null;
  }
}

/**
 * Create a notification for a user
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  try {
    // Get organization_id if not provided
    let organizationId = params.organizationId;
    if (!organizationId) {
      organizationId = await getUserOrganizationId(params.userId);
    }

    if (!organizationId) {
      console.error("Cannot create notification: user has no organization");
      return;
    }

    // @ts-ignore - notifications table exists but not in types
    const { error } = await (supabase as any)
      .from("notifications")
      .insert({
        user_id: params.userId,
        organization_id: organizationId,
        type: params.type,
        title: params.title,
        message: params.message,
        expense_id: params.expenseId || null,
      });

    if (error) {
      console.error("Error creating notification:", error);
      // Don't throw - notifications are non-critical
    }
  } catch (error) {
    console.error("Error creating notification:", error);
    // Don't throw - notifications are non-critical
  }
}

/**
 * Create notification when expense is verified
 */
export async function notifyExpenseVerified(
  expenseId: string,
  expenseTitle: string,
  employeeUserId: string,
  engineerName: string
): Promise<void> {
  await createNotification({
    userId: employeeUserId,
    type: "expense_verified",
    title: "Expense Verified",
    message: `Your expense "${expenseTitle}" has been verified by ${engineerName}`,
    expenseId,
  });
}

/**
 * Create notification when expense is approved
 */
export async function notifyExpenseApproved(
  expenseId: string,
  expenseTitle: string,
  employeeUserId: string,
  approverName: string,
  amount: number
): Promise<void> {
  await createNotification({
    userId: employeeUserId,
    type: "expense_approved",
    title: "Expense Approved",
    message: `Your expense "${expenseTitle}" (${formatINR(amount)}) has been approved by ${approverName}`,
    expenseId,
  });
}

/**
 * Create notification when new expense is submitted (for engineers/admins)
 */
export async function notifyExpenseSubmitted(
  expenseId: string,
  expenseTitle: string,
  employeeName: string,
  engineerUserId?: string | null,
  adminUserIds?: string[]
): Promise<void> {
  // Notify assigned engineer
  if (engineerUserId) {
    await createNotification({
      userId: engineerUserId,
      type: "expense_submitted",
      title: "New Expense Claim",
      message: `${employeeName} has submitted a new expense: "${expenseTitle}"`,
      expenseId,
    });
  }

  // Notify all admins if no engineer assigned (engineer expenses go to admin)
  if (adminUserIds && adminUserIds.length > 0) {
    const notifications = adminUserIds.map(adminId =>
      createNotification({
        userId: adminId,
        type: "expense_submitted",
        title: "New Expense Claim",
        message: `${employeeName} has submitted a new expense: "${expenseTitle}"`,
        expenseId,
      })
    );
    await Promise.all(notifications);
  }
}

/**
 * Notify expense owner that submission/resubmission entered a review stage.
 */
export async function notifyExpenseSubmissionProgress(
  expenseId: string,
  expenseTitle: string,
  employeeUserId: string,
  reviewerLabel: string,
): Promise<void> {
  await createNotification({
    userId: employeeUserId,
    type: "expense_submitted",
    title: "Expense Submitted",
    message: `Your expense "${expenseTitle}" has been submitted and is awaiting ${reviewerLabel} review.`,
    expenseId,
  });
}

/**
 * Notify next reviewer when hierarchy moves an expense forward.
 * Uses existing `expense_submitted` type for compatibility with DB enum/data.
 */
export async function notifyExpenseForwardedForReview(
  expenseId: string,
  expenseTitle: string,
  employeeName: string,
  reviewerLabel: string,
  reviewerUserId?: string | null,
  reviewerUserIds?: string[],
): Promise<void> {
  const title = "Expense Forwarded for Review";
  const message = `Expense "${expenseTitle}" from ${employeeName} is now awaiting ${reviewerLabel} review.`;

  if (reviewerUserId) {
    await createNotification({
      userId: reviewerUserId,
      type: "expense_submitted",
      title,
      message,
      expenseId,
    });
  }

  if (reviewerUserIds && reviewerUserIds.length > 0) {
    await Promise.all(
      reviewerUserIds.map((id) =>
        createNotification({
          userId: id,
          type: "expense_submitted",
          title,
          message,
          expenseId,
        }),
      ),
    );
  }
}

/**
 * Create notification when cashier adds money to account
 */
export async function notifyBalanceAdded(
  userId: string,
  amount: number,
  cashierName: string
): Promise<void> {
  await createNotification({
    userId,
    type: "balance_added",
    title: "Balance Updated",
    message: `Your balance has been updated. ${formatINR(amount)} has been added to your account by ${cashierName}`,
  });
}

/**
 * Create notification when engineer's expense is approved by admin
 */
export async function notifyEngineerExpenseApproved(
  expenseId: string,
  expenseTitle: string,
  engineerUserId: string,
  adminName: string,
  amount: number
): Promise<void> {
  await createNotification({
    userId: engineerUserId,
    type: "expense_approved",
    title: "Expense Approved",
    message: `Your expense "${expenseTitle}" (${formatINR(amount)}) has been approved by ${adminName}`,
    expenseId,
  });
}

/**
 * Create notification when expense is rejected
 */
export async function notifyExpenseRejected(
  expenseId: string,
  expenseTitle: string,
  employeeUserId: string,
  rejectorName: string,
  comment?: string
): Promise<void> {
  await createNotification({
    userId: employeeUserId,
    type: "expense_rejected",
    title: "Expense Rejected",
    message: `Your expense "${expenseTitle}" has been rejected by ${rejectorName}${comment ? `. Reason: ${comment}` : ''}`,
    expenseId,
  });
}

/**
 * Notify expense owner when reviewer/admin corrects their expense.
 */
export async function notifyExpenseCorrected(
  expenseId: string,
  expenseTitle: string,
  employeeUserId: string,
  editorName: string,
  reason?: string | null,
): Promise<void> {
  await createNotification({
    userId: employeeUserId,
    type: "expense_submitted",
    title: "Expense Corrected",
    message: `Your expense "${expenseTitle}" was corrected by ${editorName} and marked as adjusted${reason ? `. Reason: ${reason}` : ""}.`,
    expenseId,
  });
}

/**
 * Create notification when expense is verified above threshold (notify admins)
 */
export async function notifyExpenseVerifiedToAdmin(
  expenseId: string,
  expenseTitle: string,
  employeeName: string,
  engineerName: string,
  amount: number,
  adminUserIds: string[]
): Promise<void> {
  if (adminUserIds.length === 0) return;
  
  const notifications = adminUserIds.map(adminId =>
    createNotification({
      userId: adminId,
      type: "expense_submitted",
      title: "Expense Verified - Awaiting Approval",
      message: `${engineerName} has verified "${expenseTitle}" (${formatINR(amount)}) from ${employeeName}. Please review and approve.`,
      expenseId,
    })
  );
  
  await Promise.all(notifications);
}

