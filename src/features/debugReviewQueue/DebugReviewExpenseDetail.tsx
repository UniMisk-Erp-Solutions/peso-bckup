/**
 * Detail dialog (DOC-080 Phase 19).
 *
 * Read-only in every sense: available actions render as informational badges, and
 * attachments are listed without any delete affordance — this surface never calls
 * storage.remove, which is the defect DOC-078 exists to prevent.
 *
 * Soft-deleted receipts are excluded server-side; the count is surfaced so a
 * missing receipt reads as "deleted", not as "the page is broken".
 */

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/StatusBadge";
import { DebugReviewErrorState } from "./DebugReviewErrorState";
import { kindFromError } from "./errorKind";
import { formatAmount, formatDateOnly, formatDateTime } from "./format";
import { formatEmployeeIdentity, identityIssueLabel } from "./types";
import type { DebugReviewExpenseDetail as DetailShape } from "./types";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

export function DebugReviewExpenseDetail({
  open,
  onOpenChange,
  detail,
  loading,
  error,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: DetailShape | null;
  loading: boolean;
  error: unknown;
}) {
  const { t } = useTranslation("debugReview");
  const e = (detail?.expense ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : null);
  const identity = detail
    ? formatEmployeeIdentity({
        employee_name: detail.employee.employee_name,
        employee_id: detail.employee.employee_id,
        employee_email: detail.employee.employee_email,
        identity_issue: detail.employee.identity_issue,
      })
    : null;
  const issueKey = identityIssueLabel(detail?.employee.identity_issue);
  const batchId = str("batch_id");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-3xl overflow-y-auto"
        data-testid="debug-detail-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("detail.title")}</DialogTitle>
          <DialogDescription>
            {str("transaction_number") ?? ""} {str("title") ?? ""}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("detail.loading")}
          </p>
        )}

        {!loading && error && <DebugReviewErrorState kind={kindFromError(error)} showReviewLink={false} />}

        {!loading && !error && detail && (
          <div className="space-y-5">
            <section className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("detail.employee")}</p>
              <p className="font-medium">{identity?.primary}</p>
              <p className="text-xs text-muted-foreground">
                {issueKey ? t(`identity.${issueKey}`) : (identity?.secondary ?? "")}
              </p>
            </section>

            <Separator />

            <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label={t("table.amount")} value={formatAmount(Number(e.total_amount ?? NaN))} />
              <Field label={t("table.category")} value={str("category") ?? "—"} />
              <Field label={t("table.destination")} value={str("destination") ?? "—"} />
              <Field label={t("table.expenseDate")} value={formatDateOnly(str("trip_start"))} />
              <Field label={t("table.dateCreated")} value={formatDateTime(str("created_at"))} />
              <div>
                <p className="text-xs text-muted-foreground">{t("table.status")}</p>
                <StatusBadge status={str("status") ?? ""} />
              </div>
            </section>

            <section className="space-y-2">
              <p className="text-sm font-medium">{t("detail.actionability")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={detail.actionability.is_actionable ? "default" : "outline"}>
                  {detail.actionability.actionable_stage}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {detail.actionability.actionable_reason}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{t("detail.availableActions")}</p>
              <div className="flex flex-wrap gap-2">
                {detail.actionability.available_actions.length === 0 ? (
                  <span className="text-xs text-muted-foreground">{t("detail.noActions")}</span>
                ) : (
                  detail.actionability.available_actions.map((a) => (
                    // Informational only — this page never mutates.
                    <Badge key={a} variant="secondary">
                      {a}
                    </Badge>
                  ))
                )}
              </div>
            </section>

            {detail.custom_fields.length > 0 && (
              <section className="space-y-2">
                <p className="text-sm font-medium">{t("detail.customFields")}</p>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {detail.custom_fields.map((f, i) => (
                    <div key={`${f.field_id}-${i}`}>
                      <dt className="text-xs text-muted-foreground">{f.label ?? f.field_key}</dt>
                      <dd className="text-sm">{f.value ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <section className="space-y-2">
              <p className="text-sm font-medium">{t("detail.attachments")}</p>
              {detail.attachments.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("detail.noAttachments")}</p>
              ) : (
                <ul className="space-y-1">
                  {detail.attachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm">
                      <a
                        href={a.file_url ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate underline underline-offset-2"
                      >
                        {a.filename ?? a.id}
                      </a>
                      {a.durability_status && (
                        <Badge variant="outline" className="h-5 px-1 text-[10px]">
                          {a.durability_status}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {detail.deleted_attachment_count > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("detail.deletedAttachments", { count: detail.deleted_attachment_count })}
                </p>
              )}
            </section>

            <section className="space-y-2">
              <p className="text-sm font-medium">{t("detail.timeline")}</p>
              <ul className="space-y-1 text-xs">
                {detail.timeline.map((l) => (
                  <li key={l.id} className="flex gap-2 border-b py-1">
                    <span className="min-w-[9rem] text-muted-foreground">
                      {formatDateTime(l.created_at)}
                    </span>
                    <span className="font-mono">{l.action}</span>
                    <span className="truncate">{l.comment ?? ""}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <p className="text-sm font-medium">{t("detail.corrections")}</p>
              {detail.corrections.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("detail.noCorrections")}</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {detail.corrections.map((c) => (
                    <li key={c.id} className="flex gap-2 border-b py-1">
                      <span className="min-w-[9rem] text-muted-foreground">
                        {formatDateTime(c.created_at)}
                      </span>
                      <span className="truncate">{c.reason ?? ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {batchId && (
              <Button variant="outline" size="sm" asChild>
                <Link to={`/expenses/batch/${batchId}/review`}>
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  {t("detail.openBatch")}
                </Link>
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
