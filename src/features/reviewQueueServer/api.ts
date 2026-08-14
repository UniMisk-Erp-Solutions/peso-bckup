/**
 * Server review-queue RPC layer (DOC-080). THE single implementation.
 *
 * Both /review and /debug/review-expenses call through here. There is no second
 * copy of the response schemas, the RPC argument construction, the identity
 * parsing or the error classification.
 *
 * This module deliberately imports nothing from EngineerReview,
 * managerReviewExpenses, hierarchyReviewExpenses, reviewExpensePagination or
 * legacyReviewPagination, and never queries profiles, expense_form_field_values,
 * audit_logs or expense_correction_logs from the browser.
 *
 * The RPC names still carry the `debug_` prefix from the migration that proved
 * them. They are renamed only in a later contract-version migration, once the
 * production UI is stable — renaming now would mean a second migration for no
 * behavioural gain.
 */

import { supabase } from "@/integrations/supabase/client";
import type { ZodTypeAny, z } from "zod";
import {
  debugPageAnchorSchema,
  debugEmployeeSearchSchema,
  debugExpenseDetailSchema,
  debugFilterOptionsSchema,
  debugReviewCapabilitiesSchema,
  debugReviewPageSchema,
  DEBUG_REVIEW_SORTS,
} from "./schemas";
import {
  ReviewQueueCapabilityError,
  ReviewQueueNetworkError,
  ReviewQueueValidationError,
  translateRpcError,
} from "./errors";

/** A canonical abort error whose name callers recognise to SWALLOW (supersession). */
export class ReviewQueueAbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * True for an aborted request — an active signal OR an AbortError-shaped throw.
 * A browser AbortError is a DOMException, which is NOT `instanceof Error`, so this
 * inspects `name`/`message` structurally rather than relying on the prototype.
 */
export function isReviewAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    const message = (error as { message?: unknown }).message;
    if (name === "AbortError") return true;
    if (typeof message === "string" && /\babort(ed)?\b/i.test(message)) return true;
  }
  return false;
}

/**
 * postgrest-js does NOT wrap JSON.parse on the SUCCESS path (res.ok), so an
 * aborted or gateway-truncated 2xx body throws a raw `SyntaxError: Unexpected end
 * of JSON input` out of the awaited builder. Detect it so we can convert it to a
 * controlled, retryable transport error instead of letting it crash the page.
 */
export function isIncompleteJsonError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    /unexpected end of json|json\.parse|unexpected token|end of (data|input)/i.test(error.message)
  );
}
import type {
  ReviewCustomFilter,
  ReviewEmployeeMatch,
  ReviewEmployeeSearchResult,
  ReviewQueueCapabilities,
  ReviewQueueCursor,
  ReviewQueueExpenseDetail,
  ReviewQueueFilterOptions,
  ReviewPageAnchor,
  ReviewQueuePage,
  ReviewQueueSort,
} from "./types";

export const REVIEW_QUEUE_CONTRACT_VERSION = 1;

export const REVIEW_QUEUE_RPCS = {
  capabilities: "debug_review_queue_capabilities_v1",
  employeeSearch: "search_debug_review_employees_v1",
  page: "get_debug_review_queue_page_v1",
  filterOptions: "get_debug_review_filter_options_v1",
  detail: "get_debug_review_expense_detail_v1",
  pageAnchor: "get_debug_review_queue_page_anchor_v1",
} as const;

type RpcError = { code?: string; message?: string } | null;

async function callRpc(
  fn: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  // Single isolated cast — these RPCs are absent from the stale generated types,
  // and DOC-079 forbids hand-editing those to pretend otherwise.
  const client = supabase as unknown as {
    rpc: (
      n: string,
      p: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: RpcError }> & {
      abortSignal: (s: AbortSignal) => Promise<{ data: unknown; error: RpcError }>;
    };
  };
  // PostgREST's builder is thenable; `.abortSignal(signal)` cancels the in-flight
  // request when the caller aborts (§19/§20), so an obsolete queue query stops
  // hitting Kong/PostgREST/Postgres instead of merely being ignored client-side.
  let builder = client.rpc(fn, args);
  if (signal) builder = builder.abortSignal(signal);

  let data: unknown;
  let error: RpcError;
  try {
    ({ data, error } = await builder);
  } catch (thrown) {
    // An aborted request is intentional supersession, NEVER a user-visible crash.
    if (isReviewAbort(signal, thrown)) throw new ReviewQueueAbortError();
    // A gateway-truncated / aborted 2xx body makes postgrest-js throw a raw
    // SyntaxError from its UNguarded success-path JSON.parse. Convert it to a
    // controlled, retryable transport error so it stays inside the review error
    // UX instead of reaching the React ErrorBoundary (DOC-080 §8/§15).
    if (isIncompleteJsonError(thrown)) {
      throw new ReviewQueueNetworkError(
        "The review server returned an incomplete response. Please retry.",
      );
    }
    throw thrown;
  }
  if (error) throw translateRpcError(error);
  return data;
}

/**
 * Every RPC response goes through here. A schema mismatch becomes a controlled
 * validation error — the raw Zod issue never reaches the UI, only the console.
 */
function validate<S extends ZodTypeAny>(schema: S, raw: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    if (typeof console !== "undefined") {
      console.warn(`[reviewQueueServer] ${what} failed validation`, parsed.error.issues);
    }
    throw new ReviewQueueValidationError(`The ${what} response was not in the expected format.`);
  }
  return parsed.data;
}

// ── Capability ──────────────────────────────────────────────────────────────

export function parseCapabilities(raw: unknown): ReviewQueueCapabilities {
  const isRecord = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  const rec = isRecord ? (raw as Record<string, unknown>) : {};
  if (!isRecord || rec.contract !== "debug-review-queue") {
    throw new ReviewQueueCapabilityError("Review queue contract not installed.");
  }
  if (rec.version !== REVIEW_QUEUE_CONTRACT_VERSION) {
    throw new ReviewQueueCapabilityError(
      `Review queue contract version ${String(rec.version)}, expected ${REVIEW_QUEUE_CONTRACT_VERSION}.`,
    );
  }
  return validate(debugReviewCapabilitiesSchema, raw, "capability");
}

export async function fetchReviewQueueCapabilities(): Promise<ReviewQueueCapabilities> {
  return parseCapabilities(await callRpc(REVIEW_QUEUE_RPCS.capabilities, {}));
}

// ── Employee search (submit-driven) ─────────────────────────────────────────

export function parseEmployeeSearch(raw: unknown): ReviewEmployeeSearchResult {
  return validate(debugEmployeeSearchSchema, raw, "employee search");
}

/**
 * Resolves a name or employee ID to an immutable user_id.
 *
 * Never matches transaction numbers — that separation is the whole point.
 * Searching "6174" must return employee 6174, not transaction 06174 belonging to
 * employee 6557.
 *
 * Call this ONLY from a submit handler (button click / Enter). It is
 * intentionally not wrapped in a debounced or effect-driven query.
 */
export async function searchReviewEmployees(params: {
  organizationId: string;
  query: string;
  limit?: number;
}): Promise<ReviewEmployeeSearchResult> {
  const query = params.query.trim();
  if (!query) {
    return { contract: "debug-review-employee-search", version: 1, query: null, matches: [] };
  }
  return parseEmployeeSearch(
    await callRpc(REVIEW_QUEUE_RPCS.employeeSearch, {
      p_organization_id: params.organizationId,
      p_query: query,
      p_limit: params.limit ?? 20,
    }),
  );
}

/** Exactly one strong match may be auto-selected; anything else needs a human choice. */
export function pickAutoSelectableMatch(
  r: ReviewEmployeeSearchResult,
): ReviewEmployeeMatch | null {
  const strong = r.matches.filter(
    (m) => m.match_type === "exact_employee_id" || m.match_type === "exact_employee_name",
  );
  return strong.length === 1 ? strong[0] : null;
}

// ── Queue page ──────────────────────────────────────────────────────────────

export function parseReviewQueuePage(raw: unknown): ReviewQueuePage {
  return validate(debugReviewPageSchema, raw, "queue");
}

export type ReviewQueuePageParams = {
  organizationId: string;
  pageSize?: number;
  cursor?: ReviewQueueCursor | null;
  sort?: ReviewQueueSort;
  /** Immutable user_id. Never the employee name — names change and duplicate. */
  employeeUserId?: string | null;
  generalSearch?: string | null;
  statuses?: string[] | null;
  categories?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  actionableOnly?: boolean;
  customFilters?: ReviewCustomFilter[];
  /** Cancels the in-flight request when aborted (§19/§20). */
  signal?: AbortSignal;
};

export async function fetchReviewQueuePage(
  params: ReviewQueuePageParams,
): Promise<ReviewQueuePage> {
  const sort = params.sort ?? "created_desc";
  if (!(DEBUG_REVIEW_SORTS as readonly string[]).includes(sort)) {
    throw new ReviewQueueValidationError(`Unsupported sort: ${sort}`);
  }
  return parseReviewQueuePage(
    await callRpc(
      REVIEW_QUEUE_RPCS.page,
      {
        p_organization_id: params.organizationId,
        p_page_size: params.pageSize ?? 25,
        p_cursor: params.cursor ?? null,
        p_sort: sort,
        p_employee_user_id: params.employeeUserId ?? null,
        p_general_search: params.generalSearch ?? null,
        p_statuses: params.statuses ?? null,
        p_categories: params.categories ?? null,
        p_date_from: params.dateFrom ?? null,
        p_date_to: params.dateTo ?? null,
        p_actionable_only: params.actionableOnly ?? false,
        p_custom_filters: params.customFilters ?? [],
      },
      params.signal,
    ),
  );
}

// ── Filter options / detail ─────────────────────────────────────────────────

export function parseFilterOptions(raw: unknown): ReviewQueueFilterOptions {
  return validate(debugFilterOptionsSchema, raw, "filter options");
}

export async function fetchReviewQueueFilterOptions(
  organizationId: string,
): Promise<ReviewQueueFilterOptions> {
  return parseFilterOptions(
    await callRpc(REVIEW_QUEUE_RPCS.filterOptions, { p_organization_id: organizationId }),
  );
}

export function parseExpenseDetail(raw: unknown): ReviewQueueExpenseDetail {
  return validate(debugExpenseDetailSchema, raw, "expense detail");
}

export async function fetchReviewExpenseDetail(
  organizationId: string,
  expenseId: string,
): Promise<ReviewQueueExpenseDetail> {
  return parseExpenseDetail(
    await callRpc(REVIEW_QUEUE_RPCS.detail, {
      p_organization_id: organizationId,
      p_expense_id: expenseId,
    }),
  );
}

// ── Page anchor ─────────────────────────────────────────────────────────────

export function parsePageAnchor(raw: unknown): ReviewPageAnchor {
  return validate(debugPageAnchorSchema, raw, "page anchor");
}

/**
 * Resolves an arbitrary target page to the cursor immediately before it.
 *
 * Keyset paging has no random access, so an explicit jump costs one anchor call
 * plus one ordinary page call. Next/Previous never come through here — they stay
 * a single keyset request.
 *
 * Takes the SAME query shape as the page fetch; the server reuses one helper for
 * both, so the anchor cannot resolve against a different filtered order.
 */
export async function fetchReviewQueuePageAnchor(
  params: ReviewQueuePageParams & { targetPage: number },
): Promise<ReviewPageAnchor> {
  const sort = params.sort ?? "created_desc";
  if (!(DEBUG_REVIEW_SORTS as readonly string[]).includes(sort)) {
    throw new ReviewQueueValidationError(`Unsupported sort: ${sort}`);
  }
  if (!Number.isInteger(params.targetPage) || params.targetPage < 1) {
    throw new ReviewQueueValidationError("Target page must be 1 or greater.");
  }
  return parsePageAnchor(
    await callRpc(REVIEW_QUEUE_RPCS.pageAnchor, {
      p_organization_id: params.organizationId,
      p_target_page: params.targetPage,
      p_page_size: params.pageSize ?? 25,
      p_sort: sort,
      p_employee_user_id: params.employeeUserId ?? null,
      p_general_search: params.generalSearch ?? null,
      p_statuses: params.statuses ?? null,
      p_categories: params.categories ?? null,
      p_date_from: params.dateFrom ?? null,
      p_date_to: params.dateTo ?? null,
      p_actionable_only: params.actionableOnly ?? false,
      p_custom_filters: params.customFilters ?? [],
    }),
  );
}
