import { recordBreadcrumb } from "@/lib/monitoring";

/**
 * Coarse, content-free performance signals for the Submit / receipt-upload path (PWA incident).
 * Durations, sizes in KB, small enums and counts ONLY: never image data, tokens, ids, titles or amounts.
 */
export type SubmitMetric =
  | "upload_start"
  | "compression_done"
  | "upload_done"
  | "receipt_finalize_done"
  | "submit_start"
  | "submit_server_done"
  | "submit_reconcile"
  | "submit_success"
  | "submit_failure";

export type SubmitMetricData = {
  durationMs?: number;
  sizeKb?: number;
  count?: number;
  attempt?: number;
  /** connection | server_slow | auth | validation | other */
  errorClass?: string;
  willReconcile?: boolean;
  slow?: boolean;
  originalBytes?: number;
  optimizedBytes?: number;
  prepareMs?: number;
  compressionMs?: number;
  uploadMs?: number;
  finalizeMs?: number;
  submitMs?: number;
};

const ALLOWED_KEYS = new Set([
  "durationMs",
  "sizeKb",
  "count",
  "attempt",
  "errorClass",
  "willReconcile",
  "slow",
  "originalBytes",
  "optimizedBytes",
  "prepareMs",
  "compressionMs",
  "uploadMs",
  "finalizeMs",
  "submitMs",
]);

export function recordSubmitMetric(name: SubmitMetric, data: SubmitMetricData = {}): void {
  const safe: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!ALLOWED_KEYS.has(k) || v === undefined) continue;
    if (typeof v === "number") safe[k] = Math.round(v);
    else if (typeof v === "boolean") safe[k] = v;
    else if (typeof v === "string") safe[k] = v.slice(0, 24);
  }
  try {
    recordBreadcrumb("submit-metric", name, safe);
  } catch {
    /* telemetry must never affect the submit */
  }
}

/** Duration helper: `const done = startTimer(); ...; done()` returns elapsed ms. */
export function startTimer(): () => number {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return () => (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
}

/** Classifies an error into a coarse bucket for telemetry only (no message text is recorded). */
export function submitErrorClass(opts: { connection: boolean; serverSlow: boolean; auth: boolean; validation: boolean }): string {
  if (opts.connection) return "connection";
  if (opts.serverSlow) return "server_slow";
  if (opts.auth) return "auth";
  if (opts.validation) return "validation";
  return "other";
}
