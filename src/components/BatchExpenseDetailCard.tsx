import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { formatINR, parseLocalDate } from "@/lib/format";
import { format } from "date-fns";
import type { BatchReviewExpenseRow } from "@/lib/batchExpenseReview";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";
import { AttachmentThumbnail } from "@/components/AttachmentThumbnail";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { isPdfAttachment, normalizeReceiptPublicUrl } from "@/lib/attachmentPreview";
import { Separator } from "@/components/ui/separator";
import { X, Eye, FileText } from "lucide-react";

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
}

interface LineItem {
  id: string;
  date: string;
  category: string;
  amount: number;
  description: string;
}

interface BatchExpenseDetailCardProps {
  expense: BatchReviewExpenseRow;
  organizationId: string;
  categoryLabel?: string;
  purposeLabel?: string;
  amountLabel?: string;
  destinationLabel?: string;
  onClose: () => void;
}

export function BatchExpenseDetailCard({
  expense,
  organizationId,
  categoryLabel,
  purposeLabel,
  amountLabel,
  destinationLabel,
  onClose,
}: BatchExpenseDetailCardProps) {
  const { t } = useTranslation("expenses");
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<string | null>(null);
  const [previewFilename, setPreviewFilename] = useState<string | undefined>(undefined);
  const [previewUploadedBy, setPreviewUploadedBy] = useState<string | null>(null);

  // Sequence counter guards against stale responses overwriting newer data.
  const seqRef = useRef(0);

  const loadExpenseDetails = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setDetailError(null);
    setLineItems([]);
    setAttachments([]);

    const [lineRes, attRes] = await Promise.all([
      supabase
        .from("expense_line_items")
        .select("id, date, category, amount, description")
        .eq("expense_id", expense.id)
        .eq("organization_id", organizationId)
        .order("date"),
      supabase
        .from("attachments")
        .select("id, filename, content_type, file_url, created_at")
        .eq("expense_id", expense.id)
        .eq("organization_id", organizationId)
        .order("created_at"),
    ]);

    // Stale-response guard: if a newer request has started, discard this result.
    if (seq !== seqRef.current) return;

    if (lineRes.error || attRes.error) {
      console.warn("[BatchExpenseDetailCard]", {
        expenseId: expense.id,
        organizationId,
        lineItemsFailed: Boolean(lineRes.error),
        attachmentsFailed: Boolean(attRes.error),
      });
      setDetailError(t("batchReview.loadDetailsFailed"));
      setLoading(false);
      return;
    }

    setLineItems(
      (lineRes.data || []).map((row) => ({
        ...row,
        amount: Number(row.amount),
      })),
    );
    setAttachments(
      (attRes.data || []).map((a) => ({
        ...a,
        file_url: normalizeReceiptPublicUrl(a.file_url || ""),
      })),
    );
    setLoading(false);
  }, [expense.id, organizationId, t]);

  useEffect(() => {
    void loadExpenseDetails();
  }, [loadExpenseDetails]);

  return (
    <>
      <Card className="border-primary/30 shadow-md ring-1 ring-primary/10">
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="text-lg">{expense.title}</CardTitle>
            {expense.transaction_number && (
              <p className="text-xs font-mono text-muted-foreground mt-1">
                #{expense.transaction_number}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("batchReview.closeDetail")}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <AsyncOperationProgress
              status="running"
              title={t("batchReview.loadingDetails")}
              description={t("batchReview.loadingDetailsDescription")}
            />
          ) : detailError ? (
            <AsyncOperationProgress
              status="error"
              title={t("batchReview.loadDetailsFailed")}
              description={t("batchReview.loadDetailsFailedDescription")}
              retryLabel={t("fieldDisplay.retry")}
              onRetry={() => void loadExpenseDetails()}
            />
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">{t("batchReview.employee")}</p>
                  <p className="font-medium">{expense.user_name}</p>
                  <p className="text-xs text-muted-foreground">{expense.user_email}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{amountLabel ?? t("batchReview.amount")}</p>
                  <p className="text-lg font-semibold">{formatINR(expense.total_amount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t("batchReview.status")}</p>
                  <div className="mt-1">
                    <ExpenseStatusWithCorrectionBadge
                      status={expense.status}
                      wasReviewerCorrected={expense.wasReviewerCorrected}
                      viewerContext="reviewer"
                    />
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground">{destinationLabel ?? t("batchReview.destination")}</p>
                  <p className="font-medium">{expense.destination}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{categoryLabel ?? t("batchReview.tableCategory")}</p>
                  <p className="font-medium capitalize">{expense.category || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t("batchReview.date")}</p>
                  <p className="font-medium">
                    {format(
                      parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start),
                      "MMM d, yyyy",
                    )}
                  </p>
                </div>
              </div>

              {expense.purpose && (
                <div className="text-sm">
                  <p className="text-muted-foreground">{purposeLabel ?? t("batchReview.purpose")}</p>
                  <p>{expense.purpose}</p>
                </div>
              )}

              <ExpenseFormFieldsDisplay
                expenseId={expense.id}
                organizationId={organizationId}
                context="review"
                className="text-sm"
              />

              {lineItems.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-2">{t("batchReview.lineItems")}</p>
                    <ul className="space-y-2 text-sm">
                      {lineItems.map((item) => (
                        <li
                          key={item.id}
                          className="flex flex-wrap justify-between gap-2 border rounded-md px-3 py-2"
                        >
                          <span>
                            {item.category} — {item.description || "—"}
                          </span>
                          <span className="font-medium">{formatINR(item.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              <Separator />
              <div>
                <p className="text-sm font-medium mb-2">{t("batchReview.receiptsTitle")}</p>
                {attachments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("batchReview.noAttachments")}</p>
                ) : (
                  <ul className="space-y-2">
                    {attachments.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-3 border rounded-lg p-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {a.content_type?.startsWith("image/") ? (
                            <AttachmentThumbnail
                              fileUrl={a.file_url}
                              contentType={a.content_type}
                              alt={a.filename}
                              className="h-14 w-14 shrink-0"
                              uploadedBy={expense.user_id}
                              expenseId={expense.id}
                            />
                          ) : isPdfAttachment(a.file_url, a.content_type) ? (
                            <div className="h-14 w-14 flex items-center justify-center bg-muted rounded shrink-0">
                              <FileText className="h-6 w-6 text-muted-foreground" />
                            </div>
                          ) : (
                            <div className="h-14 w-14 flex items-center justify-center bg-muted rounded text-xs shrink-0">
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
                          onClick={() => {
                            setPreviewUrl(a.file_url);
                            setPreviewType(a.content_type);
                            setPreviewFilename(a.filename);
                            setPreviewUploadedBy(expense.user_id);
                          }}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          {t("batchReview.view")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AttachmentPreviewDialog
        open={Boolean(previewUrl)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewUrl(null);
            setPreviewType(null);
            setPreviewFilename(undefined);
            setPreviewUploadedBy(null);
          }
        }}
        url={previewUrl}
        contentType={previewType}
        filename={previewFilename}
        title={t("batchReview.previewTitle")}
        uploadedBy={previewUploadedBy}
        expenseId={expense.id}
      />
    </>
  );
}
