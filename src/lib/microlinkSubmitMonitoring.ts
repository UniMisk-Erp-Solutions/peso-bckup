import { reportError } from "@/lib/monitoring";

/**
 * Where in the MicroLink "attach first, then submit" flow a failure happened.
 *
 * GlitchTip only records explicit `reportError` calls and uncaught exceptions
 * (toasts and console output are breadcrumbs). The submit flow handles every
 * failure itself -- it shows a toast and returns -- so before this module a
 * stranded draft left no event at all, and the Oct 2026 draft incident (a
 * replayed draft receipt, no exception anywhere) was invisible in monitoring.
 */
export type MicroLinkSubmitStage =
  | "draft_save"
  | "attach_receipts"
  | "submit"
  | "submit_unconfirmed"
  | "submit_not_submitted";

function shortType(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("image/")) return t.slice("image/".length).replace("jpg", "jpeg");
  return "other";
}

/** Distinct, coarse attachment kinds ("pdf", "jpeg", ...) -- never names, sizes or URLs. */
export function summarizeAttachmentTypes(contentTypes: Iterable<string | null | undefined>): string {
  const kinds = new Set<string>();
  for (const ct of contentTypes) if (ct) kinds.add(shortType(ct));
  return kinds.size ? Array.from(kinds).sort().join(",") : "none";
}

/**
 * Report a handled failure in the MicroLink submit flow.
 *
 * Deliberately carries NO expense id, user id, amount, filename or URL: only the
 * stage, the organization slug, how many attachments and of which kinds, the
 * server error code when there is one, and (added by reportError) the release
 * and environment.
 */
export function reportMicroLinkSubmitFailure(
  stage: MicroLinkSubmitStage,
  error: unknown,
  opts: {
    attachmentCount?: number;
    attachmentTypes?: string;
    errorCode?: string;
    severity?: "warning" | "error";
    /** Semantic mismatch facts (enumerated values only): asked for X, got Y. */
    requestedAction?: string;
    receiptAction?: string;
    actualStatus?: string;
  } = {},
): void {
  reportError(error, {
    area: "expenses",
    operation: `microlink-submit-${stage.replace(/_/g, "-")}`,
    errorCode: opts.errorCode,
    severity: opts.severity ?? "error",
    tags: {
      flow: "microlink_atomic_submit",
      stage,
      org: "microlink",
      attachment_count: opts.attachmentCount ?? 0,
      attachment_types: opts.attachmentTypes ?? "none",
      ...(opts.requestedAction ? { requested_action: opts.requestedAction } : {}),
      ...(opts.receiptAction ? { receipt_action: opts.receiptAction } : {}),
      ...(opts.actualStatus ? { actual_status: opts.actualStatus } : {}),
    },
  });
}
