/**
 * Singular expense review dialog.
 *
 * Ported from origin/main:src/pages/EngineerReview.tsx (~L2673-3075) — the
 * Review Expenses modal, not the All Expenses one. Same title and description,
 * same `sm:max-w-4xl max-h-[90vh]` shell, and the same stacked Cards in the same
 * order: Employee Information + Expense Summary side by side, then Trip Details,
 * Attachments, Admin Comments, Review timeline, Reviewer corrections, Manager
 * Review. Same footer: Cancel, Correct expense, then Reject/Verify or
 * Reject/Approve.
 *
 * The previous version was built from AdminPanel's flat label/value dialog,
 * which is a different design belonging to a different page. That is the defect
 * this file exists to fix.
 *
 * What is NOT main is the data source. Everything below comes from the single
 * detail RPC — employee, base fields, custom fields, attachments, timeline,
 * corrections and actionability — so opening an expense costs one request, not
 * main's six. Actionability is read from the server, never re-derived.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins, FileText, User } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseBaseFieldsDisplay } from "@/components/ExpenseBaseFieldsDisplay";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { isUuidLikeLabel } from "@/lib/fetchExpenseFormFieldDisplay";
import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";
import { ExpenseCorrectionAuditList } from "@/components/ExpenseCorrectionAudit";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { formatINR } from "@/lib/format";
import { ReviewErrorState } from "./ReviewErrorState";
import { reviewErrorKind } from "./errorKind";
import { balanceIsShort } from "./reviewRowPresentation";
import { formatEmployeeIdentity, identityIssueLabel } from "@/features/reviewQueueServer/types";
import type { ReviewQueueExpenseDetail } from "@/features/reviewQueueServer/types";
import type { ActionableExpense, ReviewActionKind } from "@/features/reviewActions/types";

/** The detail RPC carries the same authority fields as a list row. */
function detailToActionable(
  detail: ReviewQueueExpenseDetail,
  expenseId: string,
): ActionableExpense {
  const e = detail.expense as Record<string, unknown>;
  return {
    id: expenseId,
    transaction_number: typeof e.transaction_number === "string" ? e.transaction_number : null,
    batch_id: typeof e.batch_id === "string" ? e.batch_id : null,
    user_id: typeof e.user_id === "string" ? e.user_id : "",
    status: typeof e.status === "string" ? e.status : "",
    approval_tier: typeof e.approval_tier === "string" ? e.approval_tier : null,
    total_amount: e.total_amount == null ? null : Number(e.total_amount),
    is_actionable: detail.actionability.is_actionable,
    available_actions: detail.actionability.available_actions,
    view_only: detail.actionability.view_only,
  };
}

/** Structural skeleton mirroring the real card layout, not a spinner in a void. */
function DetailSkeleton() {
  return (
    <div className="space-y-6" data-testid="review-detail-skeleton">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader className="pb-3">
              <Skeleton className="h-4 w-40" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="pb-3">
          <Skeleton className="h-4 w-28" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function ReviewExpenseDetail({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  actionsEnabled,
  moneyLocale,
  organizationId,
  callerUserId,
  pendingAction,
  comment,
  onCommentChange,
  onRetry,
  onVerify,
  onApprove,
  onReject,
  onCorrect,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: ReviewQueueExpenseDetail | null;
  loading: boolean;
  error: unknown;
  actionsEnabled: boolean;
  moneyLocale?: string;
  organizationId?: string | null;
  /** Used only to withhold actions on the reviewer's own expense. */
  callerUserId?: string | null;
  pendingAction?: ReviewActionKind | null;
  comment?: string;
  onCommentChange?: (v: string) => void;
  onRetry?: () => void;
  onVerify?: (expense: ActionableExpense) => void;
  onApprove?: (expense: ActionableExpense) => void;
  onReject?: (expense: ActionableExpense, reason: string) => void;
  onCorrect?: (expense: ActionableExpense) => void;
}) {
  const { t } = useTranslation("admin");
  const { labels: roleLabels } = useOrganizationRoleLabels();
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const e = (detail?.expense ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : null);
  const expenseId = str("id");
  const amount = e.total_amount == null ? null : Number(e.total_amount);

  const identity = detail
    ? formatEmployeeIdentity({
        employee_name: detail.employee.employee_name,
        employee_id: detail.employee.employee_id,
        employee_email: detail.employee.employee_email,
        identity_issue: detail.employee.identity_issue,
      })
    : null;
  const issueKey = identityIssueLabel(detail?.employee.identity_issue);
  const short = detail
    ? balanceIsShort({ current_balance: detail.employee.current_balance, total_amount: amount })
    : false;

  /**
   * ExpenseFormFieldsDisplay expects the flat label->value map main handed it.
   * Server order is preserved because the RPC returns the fields ordered.
   *
   * get_debug_review_expense_detail_v1 falls back field_key to the raw template/branch
   * id (t.id::text) when a field has neither a configured name nor field_key — never use
   * that as the display label, or the internal UUID renders as if it were a field name.
   * A field with no usable label is omitted rather than shown with a raw id.
   */
  const prefetchedFields = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of detail?.custom_fields ?? []) {
      const key = f.label ?? (isUuidLikeLabel(f.field_key) ? null : f.field_key);
      if (key && f.value != null && f.value !== "") out[key] = f.value;
    }
    return out;
  }, [detail]);

  const auditLogs = useMemo(
    () =>
      (detail?.timeline ?? []).map((l) => ({
        action: l.action,
        user_name: l.user_id ?? "",
        comment: l.comment ?? undefined,
        created_at: l.created_at ?? "",
      })),
    [detail],
  );

  const correctionLogs = useMemo(
    () =>
      (detail?.corrections ?? []).map((c) => ({
        id: c.id,
        expense_id: expenseId ?? "",
        edited_by: c.edited_by ?? null,
        editor_name: c.edited_by ?? null,
        reason: c.reason ?? null,
        before_json: null,
        after_json: null,
        created_at: c.created_at ?? "",
      })),
    [detail, expenseId],
  );

  const actionable = detail && expenseId ? detailToActionable(detail, expenseId) : null;
  /**
   * The client only ever subtracts. A batch line never reaches this dialog (the
   * page navigates instead), and a reviewer never acts on their own expense.
   */
  const selfOwned = Boolean(callerUserId) && actionable?.user_id === callerUserId;
  const canAct =
    actionsEnabled && Boolean(actionable) && !actionable!.view_only && !selfOwned;
  const has = (a: string) => canAct && actionable!.available_actions.includes(a);
  const busy = Boolean(pendingAction);

  const close = () => {
    setRejectMode(false);
    setRejectReason("");
    onOpenChange(false);
  };

  const act = (fn?: (x: ActionableExpense) => void) => () => {
    if (!actionable || !fn) return;
    fn(actionable);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
        {/* Widths and padding verbatim from main's Review Expenses dialog. */}
        <DialogContent
          className="max-w-[95vw] sm:max-w-4xl max-h-[95vh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6"
          data-testid="expense-review-dialog"
        >
          <DialogHeader>
            <DialogTitle className="text-lg sm:text-xl">Expense Review</DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              Review expense details and verify the submission
            </DialogDescription>
          </DialogHeader>

          {loading && <DetailSkeleton />}

          {!loading && error && (
            <ReviewErrorState kind={reviewErrorKind(error)} onRetry={onRetry} />
          )}

          {!loading && !error && detail && (
            <div className="space-y-6">
              {/* Basic Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Employee Information</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium" data-testid="review-detail-employee">
                          {identity?.primary ?? "Unknown employee"}
                        </span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {issueKey
                          ? t(`review.identity.${issueKey}`)
                          : (identity?.secondary ?? "—")}
                      </div>
                      <div className="pt-2 border-t mt-2">
                        <p className="text-xs text-muted-foreground">
                          {t("review.employeeBalance")}
                        </p>
                        <p
                          className={`text-base font-semibold ${
                            short ? "text-red-600" : "text-green-600"
                          }`}
                          data-testid="review-detail-balance"
                        >
                          {formatINR(detail.employee.current_balance, moneyLocale)}
                        </p>
                        {short && (
                          <p className="text-xs text-red-500">
                            {t("review.insufficientBalance")}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Expense Summary</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Coins className="h-4 w-4 text-muted-foreground" />
                        <span
                          className="text-lg font-semibold"
                          data-testid="review-detail-amount"
                        >
                          {amount == null ? "—" : formatINR(amount, moneyLocale)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <ExpenseStatusWithCorrectionBadge
                          status={str("status") ?? ""}
                          wasReviewerCorrected={correctionLogs.length > 0}
                          viewerContext="reviewer"
                        />
                      </div>
                      {str("status") === "level_2_verified" && (
                        <p className="text-xs text-indigo-700 font-medium">
                          Executive step complete — you can now Approve or Reject this expense.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Trip Details */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Trip Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {organizationId ? (
                    <ExpenseBaseFieldsDisplay
                      organizationId={organizationId}
                      values={{
                        title: str("title") ?? "",
                        destination: str("destination") ?? "",
                        purpose: str("purpose") ?? "",
                        expense_date: str("trip_start") ?? "",
                      }}
                      context="review"
                    />
                  ) : null}

                  {organizationId && expenseId ? (
                    <ExpenseFormFieldsDisplay
                      key={`${expenseId}-${Object.keys(prefetchedFields).sort().join(",")}`}
                      expenseId={expenseId}
                      organizationId={organizationId}
                      context="review"
                      prefetchedFields={prefetchedFields}
                      className="space-y-3 pt-3 border-t"
                    />
                  ) : null}
                </CardContent>
              </Card>

              {/* Attachments */}
              {(detail.attachments.length > 0 || detail.deleted_attachment_count > 0) && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Receipts &amp; Attachments</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {detail.attachments.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center justify-between p-3 border rounded-lg"
                          data-testid={`review-attachment-${a.id}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div className="min-w-0">
                              <p className="font-medium text-sm break-words">
                                {a.filename ?? a.id}
                              </p>
                              {a.content_type ? (
                                <p className="text-xs text-muted-foreground">{a.content_type}</p>
                              ) : null}
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            data-testid={`review-attachment-view-${a.id}`}
                            onClick={() => {
                              setPreviewUrl(a.file_url);
                              setPreviewType(a.content_type);
                              setPreviewOpen(true);
                            }}
                          >
                            View
                          </Button>
                        </div>
                      ))}
                    </div>
                    {detail.deleted_attachment_count > 0 && (
                      <p
                        className="text-xs text-muted-foreground mt-2"
                        data-testid="review-deleted-attachments"
                      >
                        {detail.deleted_attachment_count} attachment(s) were deleted and are not
                        shown.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Admin Comments */}
              {str("admin_comment") && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Admin Comments</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm">{str("admin_comment")}</p>
                  </CardContent>
                </Card>
              )}

              {/* Review timeline */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    {t("review.timeline.title", { defaultValue: "Review timeline" })}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {t("review.timeline.activity", {
                      defaultValue: "Workflow progress and every action on this expense",
                    })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ExpenseReviewTimeline
                    expense={{
                      status: str("status") ?? "",
                      total_amount: amount ?? undefined,
                      approval_tier: str("approval_tier"),
                      assigned_reviewer_id: str("assigned_reviewer_id"),
                      assigned_engineer_id: str("assigned_engineer_id"),
                      created_at: str("created_at") ?? "",
                      updated_at: str("updated_at") ?? "",
                    }}
                    auditLogs={auditLogs}
                    correctionLogs={correctionLogs as never}
                    roleLabels={roleLabels ?? undefined}
                  />
                </CardContent>
              </Card>

              {/* Reviewer corrections */}
              {correctionLogs.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Reviewer corrections (detail)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ExpenseCorrectionAuditList
                      logs={correctionLogs as never}
                      maxHeightClassName="max-h-72"
                    />
                  </CardContent>
                </Card>
              )}

              {/* Manager Review */}
              {canAct && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Manager Review</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label className="text-sm font-medium">Review Comment</Label>
                      <Textarea
                        value={comment ?? ""}
                        onChange={(ev) => onCommentChange?.(ev.target.value)}
                        placeholder="Add your review comments..."
                        className="mt-1"
                        data-testid="review-admin-comment"
                      />
                    </div>
                    {/* Reject needs a reason; it is not the review comment, so an
                        empty comment can never become a rejection reason. */}
                    {rejectMode && (
                      <div data-testid="review-reject-confirm-panel">
                        <Label htmlFor="review-reject-reason" className="text-sm font-medium">
                          Reason for rejection (required)
                        </Label>
                        <Textarea
                          id="review-reject-reason"
                          value={rejectReason}
                          onChange={(ev) => setRejectReason(ev.target.value)}
                          placeholder="Explain why this expense is being rejected..."
                          className="mt-1"
                          data-testid="review-reject-reason"
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {selfOwned && (
                <p className="text-sm text-muted-foreground" data-testid="review-self-notice">
                  You submitted this expense, so it is view-only for you.
                </p>
              )}
            </div>
          )}

          {/* Footer order and variants verbatim from main. */}
          <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={close}
              className="w-full sm:w-auto"
              data-testid="review-action-cancel"
            >
              Cancel
            </Button>

            {error && onRetry ? (
              <Button
                variant="outline"
                onClick={onRetry}
                className="w-full sm:w-auto"
                data-testid="review-detail-retry"
              >
                {t("review.errors.retry")}
              </Button>
            ) : null}

            {has("correct") && onCorrect ? (
              <Button
                type="button"
                variant="secondary"
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={act(onCorrect)}
                data-testid="review-action-correct"
              >
                Correct expense
              </Button>
            ) : null}

            {rejectMode ? (
              <>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={busy}
                  onClick={() => setRejectMode(false)}
                >
                  Back
                </Button>
                <Button
                  variant="destructive"
                  className="w-full sm:w-auto"
                  disabled={!rejectReason.trim() || busy}
                  onClick={() => {
                    if (!actionable) return;
                    onReject?.(actionable, rejectReason.trim());
                    setRejectMode(false);
                    setRejectReason("");
                  }}
                  data-testid="review-confirm-reject"
                >
                  {pendingAction === "reject" ? "Rejecting…" : "Confirm reject"}
                </Button>
              </>
            ) : (
              <>
                {has("reject") && (
                  <Button
                    variant="destructive"
                    className="w-full sm:w-auto"
                    disabled={busy}
                    onClick={() => setRejectMode(true)}
                    data-testid="review-action-reject"
                  >
                    Reject
                  </Button>
                )}
                {has("verify") && (
                  <Button
                    className="bg-blue-500 hover:bg-blue-600 w-full sm:w-auto"
                    disabled={busy}
                    onClick={act(onVerify)}
                    data-testid="review-action-verify"
                  >
                    {pendingAction === "verify" ? "Verifying…" : "Verify"}
                  </Button>
                )}
                {has("approve") && (
                  <Button
                    className="w-full sm:w-auto"
                    disabled={busy}
                    onClick={act(onApprove)}
                    data-testid="review-action-approve"
                  >
                    {pendingAction === "approve" ? "Approving…" : "Approve"}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AttachmentPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        url={previewUrl}
        contentType={previewType}
        uploadedBy={str("user_id")}
        expenseId={expenseId}
      />
    </>
  );
}
