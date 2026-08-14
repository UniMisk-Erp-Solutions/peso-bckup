import { ArrowLeft, FileText, User, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { formatINR, parseLocalDate } from "@/lib/format";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";
import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";
import { ExpenseCorrectionAuditList } from "@/components/ExpenseCorrectionAudit";
import { MobileReviewActionBar } from "./MobileReviewActionBar";
import { MobileCorrectionFields } from "./MobileCorrectionFields";
import type { EnrichedAuditLog } from "@/lib/auditLogDisplay";
import type { ExpenseCorrectionLogEntry } from "@/lib/expenseCorrectionAudit";
import type { Expense } from "@/pages/EngineerReview";

type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
};

type LineItem = {
  id: string;
  date: string;
  category: string;
  amount: number;
  description: string;
};

type Props = {
  expense: Expense | null;
  attachments: Attachment[];
  lineItems: LineItem[];
  auditLogs: EnrichedAuditLog[];
  correctionLogs: ExpenseCorrectionLogEntry[];
  timelineAssignees: { reviewer?: string | null; engineer?: string | null };
  engineerComment: string;
  setEngineerComment: (v: string) => void;
  reviewLoading: boolean;
  canApprove: boolean;
  canCorrect: boolean;
  isActionDisabled: boolean;
  engineerApprovalLimit: number;
  employeeIdLoginEnabled: boolean;
  hierarchyEnabled: boolean;
  teamLeaderTierEnabled: boolean;
  executiveTierEnabled: boolean;
  roleLabels: Record<string, string>;
  organizationId: string | null | undefined;

  // correction inline fields
  correctionDialogOpen: boolean;
  setCorrectionDialogOpen: (v: boolean) => void;
  correctionLoading: boolean;
  corrTitle: string; setCorrTitle: (v: string) => void;
  corrDestination: string; setCorrDestination: (v: string) => void;
  corrExpenseDate: string; setCorrExpenseDate: (v: string) => void;
  corrPurpose: string; setCorrPurpose: (v: string) => void;
  corrCategory: string; setCorrCategory: (v: string) => void;
  corrAmount: string; setCorrAmount: (v: string) => void;
  corrAdminComment: string; setCorrAdminComment: (v: string) => void;
  correctionReason: string; setCorrectionReason: (v: string) => void;
  corrFieldModel: import("@/lib/loadCorrectionCustomFields").CorrectionCustomFieldsModel;
  onCorrFormFieldValuesChange: (vals: Record<string, string>) => void;
  onCorrBranchValuesChange: (vals: Record<string, string>) => void;

  // actions
  onBack: () => void;
  onVerify: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCorrect: () => void;
  onSubmitCorrection: () => void;
  onPreviewAttachment: (url: string, contentType: string, uploadedBy: string | null) => void;
};

export function MobileReviewDetailView({
  expense,
  attachments,
  lineItems,
  auditLogs,
  correctionLogs,
  timelineAssignees,
  engineerComment,
  setEngineerComment,
  reviewLoading,
  canApprove,
  canCorrect,
  isActionDisabled,
  engineerApprovalLimit,
  employeeIdLoginEnabled,
  hierarchyEnabled,
  teamLeaderTierEnabled,
  executiveTierEnabled,
  roleLabels,
  organizationId,
  correctionDialogOpen,
  setCorrectionDialogOpen,
  correctionLoading,
  corrTitle, setCorrTitle,
  corrDestination, setCorrDestination,
  corrExpenseDate, setCorrExpenseDate,
  corrPurpose, setCorrPurpose,
  corrCategory, setCorrCategory,
  corrAmount, setCorrAmount,
  corrAdminComment, setCorrAdminComment,
  correctionReason, setCorrectionReason,
  corrFieldModel,
  onCorrFormFieldValuesChange,
  onCorrBranchValuesChange,
  onBack,
  onVerify,
  onApprove,
  onReject,
  onCorrect,
  onSubmitCorrection,
  onPreviewAttachment,
}: Props) {
  if (!expense) return null;

  const { getFieldLabel: getBaseFieldLabel, isVisibleOnReview } = useOrganizationExpenseFormConfig(organizationId);

  const expenseDate = expense.trip_start
    ? format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")
    : "—";

  return (
    <div className="space-y-4 pb-4">
      {/* Back header */}
      <div className="flex items-center gap-2 -mx-0">
        <Button variant="ghost" size="sm" onClick={onBack} className="px-2 h-9">
          <ArrowLeft className="h-4 w-4 mr-1" />
          Review Queue
        </Button>
      </div>

      {/* Employee + amount summary */}
      <div className="flex items-start gap-3 rounded-xl border bg-card p-3">
        <div className="rounded-full bg-muted flex items-center justify-center h-9 w-9 shrink-0">
          <User className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm truncate">{expense.title}</div>
          <div className="font-semibold text-sm mt-0.5">{expense.user_name}</div>
          <div className="text-xs text-muted-foreground truncate">
            {employeeIdLoginEnabled
              ? (expense.user_employee_id?.trim() || "—")
              : expense.user_email}
          </div>
          {employeeIdLoginEnabled && expense.user_employee_id?.trim() && (
            <div className="text-xs text-muted-foreground truncate">{expense.user_email}</div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-bold text-sm tabular-nums">
            <Coins className="h-3.5 w-3.5 inline mr-1 text-muted-foreground" />
            {formatINR(expense.total_amount)}
          </div>
          <div className={`text-xs mt-0.5 ${expense.user_balance >= expense.total_amount ? "text-green-600" : "text-red-500"}`}>
            Bal: {formatINR(expense.user_balance)}
          </div>
        </div>
      </div>

      {/* Status + meta */}
      <div className="flex flex-wrap items-center gap-2">
        <ExpenseStatusWithCorrectionBadge
          status={expense.status}
          wasReviewerCorrected={expense.wasReviewerCorrected}
          viewerContext="reviewer"
        />
        {expense.batch_id && <Badge variant="secondary" className="text-xs">Batch</Badge>}
        {(expense as { isResubmitted?: boolean }).isResubmitted && (
          <Badge variant="outline" className="text-xs border-amber-400 text-amber-700">Resubmitted</Badge>
        )}
        <span className="text-xs text-muted-foreground">{expenseDate}</span>
        {expense.category && (
          <span className="text-xs text-muted-foreground capitalize">• {expense.category}</span>
        )}
      </div>

      {/* Trip details + custom fields */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <CardTitle className="text-sm">Trip Details</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-2">
          {isVisibleOnReview("destination") && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">{getBaseFieldLabel("destination")}</label>
              <p className="text-sm">{expense.destination}</p>
            </div>
          )}
          {expense.purpose && isVisibleOnReview("purpose") && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">{getBaseFieldLabel("purpose")}</label>
              <p className="text-sm">{expense.purpose}</p>
            </div>
          )}
          {expense.admin_comment && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Admin comment</label>
              <p className="text-sm">{expense.admin_comment}</p>
            </div>
          )}
          {organizationId && (
            <ExpenseFormFieldsDisplay
              key={`${expense.id}-${Object.keys(expense.custom_fields ?? {}).sort().join(",")}`}
              expenseId={expense.id}
              organizationId={organizationId}
              context="review"
              prefetchedFields={expense.custom_fields}
              className="space-y-2 pt-2 border-t"
            />
          )}
        </CardContent>
      </Card>

      {/* Line items */}
      {lineItems.length > 0 && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Line Items
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 space-y-2">
            {lineItems.map((item) => (
              <div key={item.id} className="flex items-start justify-between text-sm py-1.5 border-b last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-xs">{item.description || "—"}</div>
                  <div className="text-xs text-muted-foreground capitalize">{item.category}</div>
                  <div className="text-xs text-muted-foreground">{format(new Date(item.date), "MMM d, yyyy")}</div>
                </div>
                <div className="text-sm font-semibold tabular-nums ml-2 shrink-0">{formatINR(item.amount)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-sm">Receipts</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 space-y-2">
            {attachments.map((att) => (
              <div key={att.id} className="flex items-center justify-between py-1.5 border-b last:border-0 gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{att.filename}</p>
                  <p className="text-xs text-muted-foreground">{att.content_type}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-xs min-h-[36px]"
                  onClick={() => onPreviewAttachment(att.file_url, att.content_type, expense.user_id)}
                >
                  View
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <CardTitle className="text-sm">Review Timeline</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <ExpenseReviewTimeline
            expense={{
              status: expense.status,
              total_amount: expense.total_amount,
              approval_tier: expense.approval_tier,
              assigned_reviewer_id: expense.assigned_reviewer_id,
              assigned_engineer_id: expense.assigned_engineer_id,
              created_at: expense.created_at,
              updated_at: (expense as { updated_at?: string }).updated_at,
            }}
            auditLogs={auditLogs}
            correctionLogs={correctionLogs}
            hierarchy={{ enabled: hierarchyEnabled, teamLeader: teamLeaderTierEnabled, executive: executiveTierEnabled }}
            roleLabels={roleLabels}
            assigneeNames={timelineAssignees}
            managerApprovalLimit={engineerApprovalLimit}
          />
        </CardContent>
      </Card>

      {/* Correction audit */}
      {correctionLogs.length > 0 && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-3">
            <CardTitle className="text-sm">Reviewer corrections</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <ExpenseCorrectionAuditList logs={correctionLogs} maxHeightClassName="max-h-64" />
          </CardContent>
        </Card>
      )}

      {/* Review comment */}
      <Card>
        <CardHeader className="pb-2 pt-3 px-3">
          <CardTitle className="text-sm">Review Comment</CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3">
          <Textarea
            value={engineerComment}
            onChange={(e) => setEngineerComment(e.target.value)}
            placeholder="Add your review comments…"
            rows={3}
            className="text-sm"
          />
        </CardContent>
      </Card>

      {/* Inline correction fields */}
      {correctionDialogOpen && (
        <MobileCorrectionFields
          organizationId={organizationId}
          corrTitle={corrTitle} setCorrTitle={setCorrTitle}
          corrDestination={corrDestination} setCorrDestination={setCorrDestination}
          corrExpenseDate={corrExpenseDate} setCorrExpenseDate={setCorrExpenseDate}
          corrPurpose={corrPurpose} setCorrPurpose={setCorrPurpose}
          corrCategory={corrCategory} setCorrCategory={setCorrCategory}
          corrAmount={corrAmount} setCorrAmount={setCorrAmount}
          corrAdminComment={corrAdminComment} setCorrAdminComment={setCorrAdminComment}
          correctionReason={correctionReason} setCorrectionReason={setCorrectionReason}
          corrFieldModel={corrFieldModel}
          onCorrFormFieldValuesChange={onCorrFormFieldValuesChange}
          onCorrBranchValuesChange={onCorrBranchValuesChange}
          loading={correctionLoading}
          onSubmit={onSubmitCorrection}
          onCancel={() => setCorrectionDialogOpen(false)}
        />
      )}

      <div className="h-20" aria-hidden="true" />
      {/* Sticky action bar */}
      <MobileReviewActionBar
        expense={expense}
        canApprove={canApprove}
        canCorrect={canCorrect}
        isActionDisabled={isActionDisabled}
        reviewLoading={reviewLoading}
        correctionOpen={correctionDialogOpen}
        onVerify={onVerify}
        onApprove={onApprove}
        onReject={onReject}
        onCorrect={onCorrect}
      />
    </div>
  );
}
