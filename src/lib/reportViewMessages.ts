/**
 * User-facing wording for the View Report preview and CSV download failures.
 *
 * Raw backend/Postgres messages must never reach the screen: they leak
 * function names and error codes and are meaningless to a manager/employee.
 */

export type ReportViewErrorKind = "expired" | "not_permitted" | "failed";

/** Classify a thrown preview/download error without ever returning its text. */
export function classifyReportViewError(err: unknown): ReportViewErrorKind {
  const raw = (err instanceof Error ? err.message : typeof err === "string" ? err : "").toLowerCase();
  if (/expired|no longer available|object not found|not found in storage|report not found|42704/.test(raw)) {
    return "expired";
  }
  if (/not permitted|permission|42501|forbidden|not authori[sz]ed/.test(raw)) {
    return "not_permitted";
  }
  return "failed";
}

export function reportViewErrorMessage(kind: ReportViewErrorKind): string {
  switch (kind) {
    case "expired":
      return "This report has expired. Generate it again to view or download it.";
    case "not_permitted":
      return "You don't have access to view this report.";
    default:
      return "Failed to load report. Please try again.";
  }
}

export function reportDownloadErrorMessage(err: unknown): string {
  return classifyReportViewError(err) === "expired"
    ? "This report file has expired. Generate the report again to download it."
    : "The file could not be downloaded. Please try again.";
}

const JOB_TIMEOUT_MESSAGE =
  "Report generation took too long while processing a large data set. Please try again. If it continues, contact support.";
const JOB_GENERIC_MESSAGE = "The report could not be generated. Please try again. If it continues, contact support.";

/**
 * Failed jobs created before the worker started mapping errors still carry the
 * raw database text in `error_message_safe` (for example
 * "page 1: canceling statement due to statement timeout"). Never render that;
 * map it here so old history rows read correctly too. Our own sentences pass
 * through unchanged.
 */
export function friendlyJobFailureMessage(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return JOB_GENERIC_MESSAGE;
  const m = text.toLowerCase();
  if (m.includes("statement timeout") || m.includes("canceling statement") || m.includes("57014")) {
    return JOB_TIMEOUT_MESSAGE;
  }
  if (
    /^(timeline )?page \d+:/.test(m) || m.startsWith("plan:") || m.includes("pgrst") ||
    m.includes("violates") || m.includes("function public.") || m.includes("syntax error")
  ) {
    return JOB_GENERIC_MESSAGE;
  }
  return text;
}

/**
 * Message for a failure to START a report (the create-job RPC). The thrown text
 * can be a raw database/PostgREST message; only a permission failure and our own
 * plain sentences are shown, everything technical collapses to the generic line.
 */
export function reportStartErrorMessage(err: unknown): string {
  if (classifyReportViewError(err) === "not_permitted") {
    return "You don't have access to generate this report.";
  }
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return friendlyJobFailureMessage(raw);
}
