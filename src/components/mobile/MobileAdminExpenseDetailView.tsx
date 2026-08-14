import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { formatINR, parseLocalDate, formatCreatedDateTime } from "@/lib/format";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";
import { ExpenseCorrectionAuditList } from "@/components/ExpenseCorrectionAudit";
import { AttachmentThumbnail } from "@/components/AttachmentThumbnail";
import { isAdminApprovableStatus } from "@/lib/approvalHierarchy";
import { useTranslation } from "@/i18n";
import type { AdminExpenseRow } from "./MobileAdminExpenseCard";
import type { EnrichedAuditLog } from "@/lib/auditLogDisplay";
import type { ExpenseCorrectionLogEntry } from "@/lib/expenseCorrectionAudit";
import type { Locale } from "date-fns";
import { getDateLocale } from "@/lib/formatLocale";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";

type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
};

type User = {
  id: string;
  name: string;
};

type Props = {
  expense: AdminExpenseRow;
  attachments: Attachment[];
  auditLogs: EnrichedAuditLog[];
  correctionLogs: ExpenseCorrectionLogEntry[];
  adminComment: string;
  setAdminComment: (v: string) => void;
  selectedStatus: string;
  setSelectedStatus: (v: string) => void;
  selectedEngineer: string;
  setSelectedEngineer: (v: string) => void;
  engineers: User[];
  reviewLoading: boolean;
  hierarchyEnabled: boolean;
  teamLeaderTierEnabled: boolean;
  executiveTierEnabled: boolean;
  canCorrect: boolean;
  onApprove: () => void;
  onReject: () => void;
  onVerify: () => void;
  onUpdateStatus: () => Promise<void>;
  onOpenCorrection: () => void;
  onClose: () => void;
  organizationId: string | null;
  onImagePreviewOpen: (url: string, ct: string, by: string | null) => void;
  employeeIdLoginEnabled: boolean;
  timelineAssignees: { reviewer?: string | null; engineer?: string | null };
};

export function MobileAdminExpenseDetailView({
  expense,
  attachments,
  auditLogs,
  correctionLogs,
  adminComment,
  setAdminComment,
  selectedStatus,
  setSelectedStatus,
  reviewLoading,
  hierarchyEnabled,
  teamLeaderTierEnabled,
  executiveTierEnabled,
  canCorrect,
  onApprove,
  onReject,
  onVerify,
  onUpdateStatus,
  onOpenCorrection,
  onClose,
  organizationId,
  onImagePreviewOpen,
  employeeIdLoginEnabled,
  timelineAssignees,
}: Props) {
  const { t, i18n } = useTranslation(["admin", "expenses"]);
  const { roleLabels } = useOrganizationRoleLabels();
  const { getFieldLabel: getBaseFieldLabel, isVisibleOnDetail } = useOrganizationExpenseFormConfig(organizationId);
  const moneyLocale = getDateLocale(i18n.language);

  const isActionable =
    expense.status === "submitted" || expense.status === "edited";
  const isHierarchyApprovable =
    isAdminApprovableStatus(expense.status) &&
    !["submitted", "edited"].includes(expense.status);

  const subline = employeeIdLoginEnabled
    ? (expense.user_employee_id?.trim() || "—")
    : (expense.user_employee_id?.trim() || expense.user_email || "—");

  return (
    <div className="space-y-5 pb-6">
      {/* Back button */}
      <button
        type="button"
        onClick={onClose}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors -ml-1"
        aria-label="Back to expense list"
      >
        <ChevronLeft className="h-4 w-4" />
        <span>All Expenses</span>
      </button>

      {/* Header */}
      <div className="space-y-0.5">
        <h2 className="text-lg font-semibold leading-tight">{expense.title}</h2>
        <p className="text-sm text-muted-foreground">{expense.destination}</p>
      </div>

      {/* Core fields */}
      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        <DetailRow label="Employee" value={expense.user_name} subValue={subline} />
        <DetailRow label={getBaseFieldLabel("amount")} value={formatINR(expense.total_amount, moneyLocale)} bold />
        {expense.category && isVisibleOnDetail("category") ? (
          <DetailRow label={getBaseFieldLabel("category")} value={expense.category} capitalize />
        ) : null}
        {expense.purpose && isVisibleOnDetail("purpose") ? (
          <DetailRow label={getBaseFieldLabel("purpose")} value={expense.purpose} />
        ) : null}
        {isVisibleOnDetail("expense_date") && (
          <DetailRow
            label={getBaseFieldLabel("expense_date")}
            value={format(
              parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start),
              "MMM d, yyyy",
            )}
          />
        )}
        <DetailRow label="Created" value={formatCreatedDateTime(expense.created_at)} />
        {expense.transaction_number ? (
          <DetailRow label="Txn #" value={expense.transaction_number} mono />
        ) : null}
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          <div className="flex items-center gap-2">
            {expense.batch_id && (
              <Badge variant="outline" className="text-xs bg-violet-50 text-violet-700 border-violet-200">
                Batch
              </Badge>
            )}
            {expense.isResubmitted && expense.status === "submitted" ? (
              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                Resubmitted
              </Badge>
            ) : (
              <ExpenseStatusWithCorrectionBadge
                status={expense.status}
                wasReviewerCorrected={expense.wasReviewerCorrected}
                viewerContext="reviewer"
              />
            )}
          </div>
        </div>
      </div>

      {/* Custom fields */}
      {organizationId ? (
        <ExpenseFormFieldsDisplay
          key={`${expense.id}-${Object.keys(expense.custom_fields ?? {}).sort().join(",")}`}
          expenseId={expense.id}
          organizationId={organizationId}
          context="review"
          prefetchedFields={expense.custom_fields}
          className="space-y-3 rounded-xl border border-border bg-card px-4 py-3"
        />
      ) : null}

      {/* Admin comment */}
      {isActionable || isHierarchyApprovable ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Admin Comment (Optional)</label>
          <Textarea
            value={adminComment}
            onChange={(e) => setAdminComment(e.target.value)}
            placeholder="Add a comment about this expense…"
            rows={3}
          />
        </div>
      ) : expense.status !== "rejected" ? (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Update Status</label>
            <Select
              value={selectedStatus}
              onValueChange={setSelectedStatus}
              disabled={expense.status === "approved"}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select new status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="verified">Verified</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Admin Comment</label>
            <Textarea
              value={adminComment}
              onChange={(e) => setAdminComment(e.target.value)}
              placeholder="Add a comment about this expense…"
              rows={3}
            />
          </div>
        </div>
      ) : null}

      {/* Action buttons */}
      <div className="space-y-2">
        {expense.status === "rejected" ? null : isActionable ? (
          <>
            <Button className="w-full" onClick={onApprove} disabled={reviewLoading}>
              Approve
            </Button>
            <Button className="w-full" variant="outline" onClick={onVerify} disabled={reviewLoading}>
              Verify
            </Button>
            <Button className="w-full" variant="destructive" onClick={onReject} disabled={reviewLoading}>
              Reject
            </Button>
          </>
        ) : isHierarchyApprovable ? (
          <>
            <Button className="w-full" onClick={onApprove} disabled={reviewLoading}>
              Approve
            </Button>
            <Button className="w-full" variant="destructive" onClick={onReject} disabled={reviewLoading}>
              Reject
            </Button>
          </>
        ) : (
          <Button
            className="w-full"
            onClick={onUpdateStatus}
            disabled={!selectedStatus || expense.status === "approved"}
          >
            Update Status
          </Button>
        )}
        {canCorrect ? (
          <Button className="w-full" variant="secondary" onClick={onOpenCorrection}>
            Correct Expense
          </Button>
        ) : null}
      </div>

      {/* Attachments */}
      {attachments.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Receipts &amp; Attachments</p>
          <div className="space-y-2">
            {attachments.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-3 border border-border rounded-xl">
                <div className="flex items-center gap-3 min-w-0">
                  {a.content_type?.startsWith("image/") ? (
                    <AttachmentThumbnail
                      fileUrl={a.file_url}
                      contentType={a.content_type}
                      alt={a.filename}
                      className="h-12 w-12 shrink-0"
                      uploadedBy={expense.user_id}
                      expenseId={expense.id}
                    />
                  ) : (
                    <div className="h-12 w-12 flex items-center justify-center bg-muted rounded-lg text-xs shrink-0">
                      FILE
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{a.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(a.created_at), "MMM d, yyyy")}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 ml-2"
                  onClick={() => onImagePreviewOpen(a.file_url, a.content_type, expense.user_id)}
                >
                  View
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Correction audit */}
      {correctionLogs.length > 0 ? (
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">Reviewer Corrections</p>
          <ExpenseCorrectionAuditList logs={correctionLogs} maxHeightClassName="max-h-72" />
        </div>
      ) : null}

      {/* Review timeline */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm font-medium">
          {t("admin:review.timeline.title", { defaultValue: "Review Timeline" })}
        </p>
        <ExpenseReviewTimeline
          expense={{
            status: expense.status,
            approval_tier: expense.approval_tier,
            assigned_reviewer_id: expense.assigned_reviewer_id,
            assigned_engineer_id: expense.assigned_engineer_id,
            created_at: expense.created_at,
            updated_at: expense.updated_at,
          }}
          auditLogs={auditLogs}
          correctionLogs={correctionLogs}
          hierarchy={{
            enabled: hierarchyEnabled,
            teamLeader: teamLeaderTierEnabled,
            executive: executiveTierEnabled,
          }}
          roleLabels={roleLabels}
          assigneeNames={timelineAssignees}
        />
      </div>
    </div>
  );
}

type DetailRowProps = {
  label: string;
  value: string;
  subValue?: string;
  bold?: boolean;
  mono?: boolean;
  capitalize?: boolean;
};

function DetailRow({ label, value, subValue, bold, mono, capitalize }: DetailRowProps) {
  return (
    <div className="px-4 py-3 flex items-start justify-between gap-3">
      <span className="text-xs font-medium text-muted-foreground shrink-0 mt-0.5">{label}</span>
      <div className="text-right min-w-0">
        <p
          className={[
            "text-sm leading-snug",
            bold ? "font-semibold" : "font-normal",
            mono ? "font-mono" : "",
            capitalize ? "capitalize" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {value}
        </p>
        {subValue ? (
          <p className="text-xs text-muted-foreground mt-0.5">{subValue}</p>
        ) : null}
      </div>
    </div>
  );
}
