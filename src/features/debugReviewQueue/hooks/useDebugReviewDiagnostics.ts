/**
 * Redacted diagnostics (DOC-080 Phase 20).
 *
 * Everything here is safe to paste into a ticket. The builder takes only the
 * fields listed below — it never reads storage, cookies or the Supabase session,
 * so a token cannot reach the clipboard even by accident. IDs are masked to a
 * short prefix, which is enough to correlate rows without publishing them.
 */

import { useMemo } from "react";
import {
  DEBUG_REVIEW_ACTIONS_ENABLED,
  DEBUG_REVIEW_EXPENSES_ENABLED,
} from "@/config/debugReviewQueueFeature";
import { categorizeDebugReviewError, type DebugReviewCursor } from "../types";

/** Keeps a recognisable prefix so two rows can be compared, nothing more. */
export function maskId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length <= 8 ? `${id.slice(0, 2)}…` : `${id.slice(0, 8)}…`;
}

/** Substrings that must never appear in copied diagnostics. */
const FORBIDDEN_KEY_PATTERN =
  /(token|jwt|password|secret|apikey|api_key|authorization|cookie|session|service_role|connection)/i;

export type DebugDiagnosticsInput = {
  contract: string | null;
  contractVersion: number | null;
  capabilityReady: boolean;
  functions: Record<string, boolean> | null;
  schemaRevision: string | null;
  reviewerRole: string | null;
  organizationId: string | null;
  selectedEmployeeId: string | null;
  selectedEmployeeUserId: string | null;
  submittedEmployeeSearch: string | null;
  submittedGeneralSearch: string | null;
  pageSize: number;
  logicalPage: number;
  filteredTotal: number | null;
  returnedRows: number | null;
  hasMore: boolean | null;
  currentCursor: DebugReviewCursor | null;
  nextCursor: DebugReviewCursor | null;
  requestDurationMs: number | null;
  identityResolved: number | null;
  identityUnresolved: number | null;
  error: unknown;
  timestamp: string;
};

export type DebugDiagnostics = Record<string, string | number | boolean | null>;

export function buildRedactedDiagnostics(i: DebugDiagnosticsInput): DebugDiagnostics {
  const buildSha =
    (typeof import.meta !== "undefined" &&
      (import.meta.env?.VITE_COMMIT_SHA as string | undefined)) ||
    null;

  const out: DebugDiagnostics = {
    build_sha: buildSha ? buildSha.slice(0, 8) : null,
    page_flag_enabled: DEBUG_REVIEW_EXPENSES_ENABLED,
    actions_flag_enabled: DEBUG_REVIEW_ACTIONS_ENABLED,
    contract: i.contract,
    contract_version: i.contractVersion,
    capability_ready: i.capabilityReady,
    functions: i.functions ? JSON.stringify(i.functions) : null,
    schema_revision: i.schemaRevision,
    reviewer_role: i.reviewerRole,
    organization_id: maskId(i.organizationId),
    active_rpc: "get_debug_review_queue_page_v1",
    selected_employee_id: i.selectedEmployeeId,
    selected_employee_user_id: maskId(i.selectedEmployeeUserId),
    submitted_employee_search: i.submittedEmployeeSearch,
    submitted_general_search: i.submittedGeneralSearch,
    page_size: i.pageSize,
    logical_page: i.logicalPage,
    filtered_total: i.filteredTotal,
    returned_rows: i.returnedRows,
    has_more: i.hasMore,
    current_cursor: i.currentCursor ? `${i.currentCursor.sk}|${maskId(i.currentCursor.id)}` : null,
    next_cursor: i.nextCursor ? `${i.nextCursor.sk}|${maskId(i.nextCursor.id)}` : null,
    request_duration_ms: i.requestDurationMs,
    identity_resolved: i.identityResolved,
    identity_unresolved: i.identityUnresolved,
    error_category: i.error ? categorizeDebugReviewError(i.error) : null,
    request_timestamp: i.timestamp,
  };

  // Belt and braces: drop anything whose key or value looks like a credential,
  // even though nothing above can produce one.
  for (const [k, v] of Object.entries(out)) {
    if (FORBIDDEN_KEY_PATTERN.test(k)) delete out[k];
    else if (typeof v === "string" && FORBIDDEN_KEY_PATTERN.test(v)) out[k] = "[redacted]";
  }
  return out;
}

export function useDebugReviewDiagnostics(input: DebugDiagnosticsInput) {
  const diagnostics = useMemo(() => buildRedactedDiagnostics(input), [input]);
  const text = useMemo(() => JSON.stringify(diagnostics, null, 2), [diagnostics]);
  return { diagnostics, text };
}
